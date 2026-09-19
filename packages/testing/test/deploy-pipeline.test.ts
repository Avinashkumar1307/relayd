import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The deploy pipeline's guarantees (BUILD-PLAN Phase 10; docs/10 "CI/CD").
 *
 * The checklist item is: "build once, promote the same image digest;
 * migrations as a one-off ECS task before service update; smoke tests
 * against staging; manual approval to production; rollback = redeploy
 * previous digest."
 *
 * Every clause of that is a property somebody can break with a plausible
 * edit — adding a build step to the production job to "make sure it is
 * fresh", moving the migration after the deploy because it is slow, or
 * dropping the approval gate during a busy week. None of them fail visibly:
 * a pipeline that rebuilds for production works perfectly right up until
 * the build is not reproducible, which is the day you needed it to be.
 *
 * So the properties are asserted here rather than left to review.
 *
 * The workflows are parsed as YAML rather than grepped, because the things
 * that matter are structural — which job `needs` which, whether a step with
 * a `docker build` exists inside a particular job — and a text match cannot
 * tell the production job's steps from the build job's.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  environment?: string | { name?: string; url?: string };
  steps?: Step[];
}

interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

async function workflow(name: string): Promise<Workflow> {
  const source = await readFile(path.join(repoRoot, '.github/workflows', name), 'utf8');
  return parse(source) as Workflow;
}

async function script(name: string): Promise<string> {
  return readFile(path.join(repoRoot, 'scripts/deploy', name), 'utf8');
}

function job(flow: Workflow, name: string): Job {
  const found = flow.jobs?.[name];
  if (found === undefined) throw new Error(`no job "${name}"; found ${Object.keys(flow.jobs ?? {})}`);
  return found;
}

function stepText(one: Step): string {
  return [one.name, one.run, one.uses, JSON.stringify(one.with ?? {})].filter(Boolean).join('\n');
}

function jobText(one: Job): string {
  return (one.steps ?? []).map(stepText).join('\n');
}

/** The index of the first step whose text matches, or -1. */
function indexOfStep(one: Job, pattern: RegExp): number {
  return (one.steps ?? []).findIndex((step) => pattern.test(stepText(step)));
}

describe('the deploy workflow is there to be read', () => {
  // The tripwire. Every assertion below reaches into these jobs by name, so
  // a renamed job or a moved file would otherwise make the suite vacuously
  // green.
  it('has the three jobs the pipeline is built from', async () => {
    const deploy = await workflow('deploy.yml');

    expect(Object.keys(deploy.jobs ?? {}).sort()).toEqual(['build', 'production', 'staging']);
  });

  it('has a rollback workflow', async () => {
    const rollback = await workflow('rollback.yml');

    expect(Object.keys(rollback.jobs ?? {})).toContain('rollback');
  });
});

describe('build once, promote the same digest', () => {
  it('builds in exactly one job', async () => {
    // docs/10: "Never rebuild for production — a rebuilt image is a
    // different artifact than the one you tested."
    const deploy = await workflow('deploy.yml');
    const builders = Object.entries(deploy.jobs ?? {})
      .filter(([, one]) => /docker\s+buildx?\s+build/u.test(jobText(one)))
      .map(([name]) => name);

    expect(builders).toEqual(['build']);
  });

  it('deploys staging and production from the build job output', async () => {
    // Not "a digest" — *that* digest. Both environments must name the same
    // output of the same job, which is what makes them the same artifact.
    //
    // Read out of the deploy step specifically. A job-wide search passes
    // while the deploy step ships `relayd:latest`, because the migration
    // step in the same job still mentions the digest — and the migration
    // running the right image is no comfort at all if the services do not.
    const deploy = await workflow('deploy.yml');

    for (const name of ['staging', 'production']) {
      const steps = job(deploy, name).steps ?? [];
      const deployStep = steps.find((step) => /deploy-services\.sh/u.test(stepText(step)));

      expect(deployStep, `${name} has no deploy step`).toBeDefined();
      expect(stepText(deployStep ?? {}), name).toContain('needs.build.outputs.image');
    }
  });

  it('gives production no way to build even if somebody wanted to', async () => {
    // The structural half. `build` is the only job that checks out with a
    // Docker context and sets up buildx, so the property does not rest on
    // anybody remembering it.
    const deploy = await workflow('deploy.yml');
    const production = jobText(job(deploy, 'production'));

    expect(production).not.toMatch(/setup-buildx/u);
    expect(production).not.toMatch(/docker\s+buildx?\s+build/u);
  });

  it('refuses an image that is not pinned by digest', async () => {
    // The runtime half, in the one place every deploy passes through. A
    // workflow can be edited; this refuses a tag whatever calls it.
    const source = await script('register-revision.sh');

    expect(source).toMatch(/\*@sha256:\*\)/u);
    expect(source).toMatch(/exit 2/u);
  });
});

describe('migrations run as a one-off task before the service update', () => {
  it('migrates before deploying, in both environments', async () => {
    // CLAUDE.md section 12: "Never run migrations at container start." The
    // order is the other half — a migration after the service update means
    // the new code runs against the old schema, which is the failure
    // expand-then-contract is not designed to survive.
    const deploy = await workflow('deploy.yml');

    for (const name of ['staging', 'production']) {
      const one = job(deploy, name);
      const migrate = indexOfStep(one, /migrate\.sh/u);
      const update = indexOfStep(one, /deploy-services\.sh/u);

      expect(migrate, `${name} has no migration step`).toBeGreaterThanOrEqual(0);
      expect(update, `${name} has no deploy step`).toBeGreaterThanOrEqual(0);
      expect(migrate, `${name} migrates after deploying`).toBeLessThan(update);
    }
  });

  it('fails the deploy when the migration container exits non-zero', async () => {
    const source = await script('migrate.sh');

    expect(source).toContain('exitCode');
    expect(source).toMatch(/exit "\$exit_code"/u);
  });

  it('treats a missing exit code as a failure rather than a zero', async () => {
    // The case that actually bites: a task that never started has no exit
    // code at all, and `[ "" -eq 0 ]` is a shell error, not a clean false.
    // Read as a success it would deploy on top of unrun migrations.
    const source = await script('migrate.sh');

    expect(source).toMatch(/if \[ -z "\$exit_code" \]/u);
  });

  it('never runs migrations on the rollback path', async () => {
    // docs/10: "Database rollback is almost never a down-migration — it is
    // a forward fix." A migration step here would re-apply the schema that
    // is being rolled away from, or invite a down-migration into the
    // pipeline.
    const rollback = await workflow('rollback.yml');

    expect(jobText(job(rollback, 'rollback'))).not.toContain('migrate.sh');
  });
});

describe('staging is smoke-tested, and production is gated behind it', () => {
  it('smoke-tests both environments', async () => {
    const deploy = await workflow('deploy.yml');

    for (const name of ['staging', 'production']) {
      expect(jobText(job(deploy, name)), name).toContain('smoke.sh');
    }
  });

  it('smoke-tests after deploying, not before', async () => {
    const deploy = await workflow('deploy.yml');

    for (const name of ['staging', 'production']) {
      const one = job(deploy, name);

      expect(indexOfStep(one, /deploy-services\.sh/u), name).toBeLessThan(
        indexOfStep(one, /smoke\.sh/u),
      );
    }
  });

  it('runs production only after staging has passed', async () => {
    const deploy = await workflow('deploy.yml');
    const needs = job(deploy, 'production').needs ?? [];

    expect([needs].flat()).toContain('staging');
  });

  it('puts production behind a named environment, which is where approval lives', async () => {
    // GitHub's required reviewers hang off the environment, configured on
    // the repository. Deliberately not expressible in this file: a gate
    // written here could be deleted by the same pull request that needed
    // approving.
    const deploy = await workflow('deploy.yml');
    const environment = job(deploy, 'production').environment;

    const name = typeof environment === 'string' ? environment : environment?.name;
    expect(name).toBe('production');
  });

  it('keeps smoke tests read-only', async () => {
    // It runs against production. A smoke test that created a workspace or
    // sent an email would be creating real customer-visible data on every
    // deploy.
    //
    // curl issues a GET unless something asks it not to, so the check is
    // for the flags that would: an explicit method, or a request body.
    // `tr -d` is stripped first — its `-d` is the delete flag of a
    // different program, and matching it would make this test fail for a
    // reason that has nothing to do with what it is asserting.
    const source = (await script('smoke.sh')).replaceAll(/\btr\s+-d\b/gu, 'tr');

    expect(source).not.toMatch(/-X\s*['"]?(POST|PUT|PATCH|DELETE)/iu);
    expect(source).not.toMatch(/(^|\s)(-d|--data\S*|-F|--form|-T|--upload-file)(\s|=)/u);
  });
});

describe('rollback is redeploying the previous digest', () => {
  it('resolves the previous digest without being told one', async () => {
    // docs/10 gives rollback a three-minute budget. An operator finding a
    // digest by hand, mid-incident, does not fit in it.
    const rollback = await workflow('rollback.yml');

    expect(jobText(job(rollback, 'rollback'))).toContain('previous-digest.sh');
  });

  it('skips past revisions carrying the image already running', async () => {
    // Rolling back onto the same digest looks exactly like a successful
    // rollback and changes nothing — the worst outcome available during an
    // incident, because it costs the three minutes and then tells you the
    // deploy was not the problem.
    const source = await script('previous-digest.sh');

    expect(source).toMatch(/!= "\$current"/u);
  });

  it('refuses to roll back onto a tag', async () => {
    const source = await script('previous-digest.sh');

    expect(source).toMatch(/\*@sha256:\*\)/u);
  });
});

describe('the pipeline cannot race itself', () => {
  it('serialises deploys and rollbacks into one concurrency group', async () => {
    // Two deploys at once would race on the migration task and on
    // update-service. Rollback shares the group because a rollback racing a
    // deploy is the same problem during the worst possible hour.
    const deploy = await workflow('deploy.yml');
    const rollback = await workflow('rollback.yml');

    expect(deploy.concurrency?.group).toBe('deploy');
    expect(rollback.concurrency?.group).toBe('deploy');
  });

  it('never cancels a deploy in flight', async () => {
    // A cancelled deploy leaves services pointed at a revision the pipeline
    // never verified, and possibly a migration half-applied.
    const deploy = await workflow('deploy.yml');

    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('the pipeline holds no long-lived AWS credentials', () => {
  it('assumes a role through OIDC', async () => {
    for (const name of ['deploy.yml', 'rollback.yml']) {
      const flow = await workflow(name);

      expect(flow.permissions?.['id-token'], name).toBe('write');

      const text = Object.values(flow.jobs ?? {}).map(jobText).join('\n');
      expect(text, name).toContain('role-to-assume');
      expect(text, name).not.toMatch(/AWS_SECRET_ACCESS_KEY/u);
    }
  });

  it('uses a different role for production than for staging', async () => {
    // A staging deploy should not hold credentials that can touch
    // production, which is the whole reason the environments are separate
    // AWS accounts.
    const deploy = await workflow('deploy.yml');

    expect(jobText(job(deploy, 'staging'))).toContain('AWS_DEPLOY_ROLE_ARN');
    expect(jobText(job(deploy, 'production'))).toContain('AWS_PRODUCTION_DEPLOY_ROLE_ARN');
  });
});

describe('CI checks what it claims to check', () => {
  it('requires the billing suite rather than letting it skip', async () => {
    // CLAUDE.md section 4: "a billing suite that silently skips in CI is
    // indistinguishable from one that passes."
    //
    // The value, not the presence of the name. Set to an empty string the
    // variable is still there for any search to find, and
    // `scripts/test-billing.sh` reads it as unset — which is the exact
    // silent skip this is here to prevent.
    const ci = await workflow('ci.yml');
    const billing = job(ci, 'billing') as Job & { env?: Record<string, string> };

    expect(jobText(billing)).toContain('test:billing');
    expect(billing.env?.['RELAYD_REQUIRE_BILLING_TESTS']).toBe('1');
  });

  it('validates the Terraform, not only the text of it', async () => {
    const ci = await workflow('ci.yml');
    const text = jobText(job(ci, 'terraform'));

    expect(text).toContain('terraform fmt -check');
    expect(text).toContain('validate');
  });
});
