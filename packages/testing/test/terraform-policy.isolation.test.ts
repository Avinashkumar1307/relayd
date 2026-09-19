import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Terraform policy assertions (INVARIANTS R21 and R34; findings F21, F34).
 *
 * R21's proving test, verbatim: "Terraform policy test: no `Resource: "*"` on
 * `secretsmanager:*`". R34's: "Terraform plan assertions per environment".
 *
 * ## What this is, and what it is not
 *
 * It reads the committed `.tf` files as text. It does not run Terraform,
 * which is not installed in CI for the unit suite and would need
 * credentials to plan against anything real. So it proves what is *written*,
 * not what is *deployed* — a policy attached out of band, or a console
 * change, is invisible to it.
 *
 * That is still the check worth having. F21 is about a policy somebody wrote
 * with a wildcard because scoping was fiddly, and this fails the moment
 * anybody does that. The deployed-state half belongs with a drift check
 * against a real account, and is on the Phase 10 gate rather than here.
 *
 * The parsing is deliberately structural rather than a full HCL parse: block
 * boundaries by brace depth, and the statements read from those. A real
 * parser would be better and is a dependency for one test.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const terraformRoot = path.resolve(here, '../../../infra/terraform');

interface TerraformFile {
  path: string;
  source: string;
}

async function terraformFiles(): Promise<TerraformFile[]> {
  const files: TerraformFile[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.terraform') continue;
        await walk(full);
        continue;
      }

      if (!entry.name.endsWith('.tf')) continue;
      files.push({
        path: path.relative(terraformRoot, full).replaceAll('\\', '/'),
        source: await readFile(full, 'utf8'),
      });
    }
  }

  await walk(terraformRoot);
  return files;
}

/** Strips `#` and `//` comments, so a wildcard in prose is not a finding. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/u, '$1'))
    .join('\n');
}

/**
 * Every `statement { ... }` block, by brace depth.
 *
 * Depth rather than a regex because a statement contains nested `condition`
 * and `principals` blocks, and a non-greedy match to the first `}` would cut
 * a statement in half and read the remainder as the next one.
 */
function statementBlocks(source: string): string[] {
  const clean = withoutComments(source);
  const blocks: string[] = [];
  const opener = /\bstatement\s*\{/gu;

  let match: RegExpExecArray | null;
  while ((match = opener.exec(clean)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;

    while (index < clean.length && depth > 0) {
      const character = clean[index];
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      index += 1;
    }

    blocks.push(clean.slice(start, index - 1));
  }

  return blocks;
}

/**
 * Resolves `local.x` one level, against the `locals` blocks in the same file.
 *
 * Without this the prefix check below would only pass for an ARN written
 * inline, which would push the ARN patterns out of the one `locals` block
 * where they can be read together — a worse arrangement that happens to
 * satisfy a test.
 */
function resolveLocals(source: string, value: string): string {
  const clean = withoutComments(source);

  return value.replace(/\$\{local\.([A-Za-z0-9_]+)\}|local\.([A-Za-z0-9_]+)/gu, (whole, a, b) => {
    const name = (a ?? b) as string;
    const assignment = new RegExp(`\\n\\s*${name}\\s*=\\s*"([^"]*)"`, 'u').exec(clean);
    return assignment?.[1] ?? whole;
  });
}

function listValues(block: string, field: string): string[] {
  const match = new RegExp(`${field}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(block);
  if (match?.[1] === undefined) return [];

  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

describe('the Terraform is there to be read', () => {
  it('finds modules and both environments', async () => {
    // The tripwire. Every assertion below iterates over these files, so a
    // path that stops resolving would make the whole suite vacuously green.
    const files = await terraformFiles();
    const paths = files.map((file) => file.path);

    expect(files.length).toBeGreaterThan(10);
    expect(paths.some((file) => file.startsWith('modules/security/'))).toBe(true);
    expect(paths.some((file) => file.startsWith('environments/production/'))).toBe(true);
    expect(paths.some((file) => file.startsWith('environments/staging/'))).toBe(true);
  });

  it('finds IAM statements to check', async () => {
    const files = await terraformFiles();
    const statements = files.flatMap((file) => statementBlocks(file.source));

    expect(statements.length).toBeGreaterThan(5);
  });
});

describe('R21: Secrets Manager is never granted on a wildcard', () => {
  it('has no statement combining a secretsmanager action with Resource "*"', async () => {
    // The invariant's own proving test. F21: "One task role with
    // `secretsmanager:GetSecretValue` on a wildcard means any RCE or SSRF in
    // any worker yields every customer's SES keys."
    const files = await terraformFiles();
    const violations: string[] = [];

    for (const file of files) {
      for (const block of statementBlocks(file.source)) {
        const actions = listValues(block, 'actions');
        const touchesSecrets = actions.some((action) => action.includes('secretsmanager:'));
        if (!touchesSecrets) continue;

        const resources = listValues(block, 'resources');
        const wildcard = resources.some((resource) => resource === '"*"');

        if (wildcard) {
          const sid = /sid\s*=\s*"([^"]*)"/u.exec(block)?.[1] ?? '(unnamed)';
          violations.push(`${file.path} ${sid}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('grants every secret action against a relayd path prefix', async () => {
    // Stronger than "not a wildcard", and the property that actually matters:
    // a grant on some other account's ARN pattern would pass the check above
    // and still be wrong.
    const files = await terraformFiles();
    const problems: string[] = [];

    for (const file of files) {
      for (const block of statementBlocks(file.source)) {
        const actions = listValues(block, 'actions');
        if (!actions.some((action) => action.includes('secretsmanager:'))) continue;

        const resources = listValues(block, 'resources');
        expect(resources.length, `${file.path} has a secrets statement with no resources`).toBeGreaterThan(0);

        for (const resource of resources) {
          if (!resolveLocals(file.source, resource).includes('relayd/')) {
            problems.push(`${file.path}: ${resource}`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('uses the path shape R21 specifies', async () => {
    // `relayd/{env}/ws/...` for customer credentials and `relayd/{env}/app/...`
    // for ours. The split is what lets the api role be kept off the first.
    const security = await readFile(path.join(terraformRoot, 'modules/security/main.tf'), 'utf8');

    expect(security).toContain('secret:relayd/${var.environment}/ws/*');
    expect(security).toContain('secret:relayd/${var.environment}/app/*');
  });

  it('ends every secret ARN pattern with the suffix wildcard', async () => {
    // Secrets Manager appends six random characters to every ARN. A pattern
    // without a trailing `-*` matches nothing, the grant silently does
    // nothing, and the fix somebody reaches for is widening to `*`.
    const files = await terraformFiles();
    const problems: string[] = [];

    for (const file of files) {
      for (const block of statementBlocks(file.source)) {
        const actions = listValues(block, 'actions');
        if (!actions.some((action) => action.includes('secretsmanager:'))) continue;

        for (const resource of listValues(block, 'resources')) {
          const resolved = resolveLocals(file.source, resource);
          if (!resolved.includes('relayd/')) continue;
          if (!resolved.includes('-*')) problems.push(`${file.path}: ${resolved}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps the api role off the customer credential tree', async () => {
    // F21's actual fix, and the one a refactor is most likely to undo by
    // adding `api` to a list because it seemed harmless.
    const variables = await readFile(
      path.join(terraformRoot, 'modules/security/variables.tf'),
      'utf8',
    );

    const readers = /variable "workspace_secret_readers"[\s\S]*?default\s*=\s*\[([^\]]*)\]/u.exec(
      variables,
    );

    expect(readers?.[1]).toBeDefined();
    expect(readers?.[1]).not.toContain('"api"');
    expect(readers?.[1]).toContain('"worker"');
  });
});

describe('no policy anywhere grants everything', () => {
  it('has no statement with both a wildcard action and a wildcard resource', async () => {
    // Broader than R21 and cheap. `Action: "*"` on `Resource: "*"` is an
    // administrator, and nothing in this stack needs one.
    const files = await terraformFiles();
    const violations: string[] = [];

    for (const file of files) {
      for (const block of statementBlocks(file.source)) {
        const actions = listValues(block, 'actions');
        const resources = listValues(block, 'resources');

        if (actions.includes('"*"') && resources.includes('"*"')) {
          violations.push(file.path);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('never grants iam:* or sts:AssumeRole to a task', async () => {
    // A task that can assume a role or edit a policy can grant itself
    // whatever the prefix scoping above was there to withhold.
    const security = await readFile(path.join(terraformRoot, 'modules/security/main.tf'), 'utf8');

    for (const block of statementBlocks(security)) {
      const actions = listValues(block, 'actions');

      // The trust policies are the exception: `sts:AssumeRole` there is what
      // ECS uses to assume the role, not something the task can call.
      const isTrustPolicy = block.includes('ecs-tasks.amazonaws.com');
      if (isTrustPolicy) continue;

      for (const action of actions) {
        expect(action, `${action} in a task policy`).not.toMatch(/"iam:/u);
        expect(action, `${action} in a task policy`).not.toMatch(/"sts:AssumeRole"/u);
      }
    }
  });
});

describe('the load balancer never routes the metrics endpoint', () => {
  it('routes no path pattern that would reach /metrics', async () => {
    // `apps/api` and `apps/edge` both serve `/metrics`, and the routing is
    // the *only* thing keeping it off the internet: on edge every route is
    // unauthenticated by design, so there is no auth middleware that would
    // have caught this.
    //
    // An exposition endpoint is a map of the system — route names, queue
    // names, error rates, enough timing to tell when a campaign is sending.
    // Not credentials, but not public either, and a listener rule added for
    // an unrelated reason is a plausible way to expose it silently.
    for (const environment of ['production', 'staging']) {
      const main = await readFile(
        path.join(terraformRoot, `environments/${environment}/main.tf`),
        'utf8',
      );

      const patterns = [...withoutComments(main).matchAll(/path_patterns\s*=\s*\[([^\]]*)\]/gu)]
        .flatMap((match) => (match[1] ?? '').split(','))
        .map((entry) => entry.trim().replaceAll('"', ''))
        .filter((entry) => entry !== '');

      expect(patterns.length, `${environment} has no path patterns`).toBeGreaterThan(0);

      for (const pattern of patterns) {
        // A rule is a match if a prefix ending in `*` covers `/metrics`, or
        // if it names it outright.
        const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
        const reaches = pattern.endsWith('*')
          ? '/metrics'.startsWith(prefix)
          : pattern === '/metrics';

        expect(reaches, `${environment} routes ${pattern}, which reaches /metrics`).toBe(false);
      }
    }
  });
});

describe('R34: the environments differ where they should', () => {
  it('runs Multi-AZ in production and not in staging', async () => {
    // Read out of the `data` module call specifically. Both environments
    // also pass a `multi_az` to `observability`, which decides whether the
    // replica-lag alarm exists — a loose match finds that one and passes
    // while the database itself is single-AZ.
    for (const [environment, expected] of [
      ['production', true],
      ['staging', false],
    ] as const) {
      const main = await readFile(
        path.join(terraformRoot, `environments/${environment}/main.tf`),
        'utf8',
      );

      const dataModule = /module "data" \{([\s\S]*?)^\}/mu.exec(main)?.[1];
      expect(dataModule, `${environment} has no data module`).toBeDefined();

      const multiAz = /multi_az\s*=\s*(true|false)/u.exec(dataModule ?? '')?.[1];
      expect(multiAz, `${environment} data module multi_az`).toBe(String(expected));
    }
  });

  it('runs one Redis instance in each, not one per purpose', async () => {
    // F34: "separate Redis instances for queue and rate limiting before any
    // measurement". One replication group per environment, and the traffic
    // is separated by keyspace prefix instead.
    const files = await terraformFiles();
    const groups = files.flatMap((file) =>
      [...file.source.matchAll(/resource\s+"aws_elasticache_replication_group"/gu)].map(
        () => file.path,
      ),
    );

    expect(groups).toHaveLength(1);
  });

  it('separates Redis traffic by keyspace prefix', async () => {
    const compute = await readFile(path.join(terraformRoot, 'modules/compute/main.tf'), 'utf8');

    expect(compute).toContain('REDIS_KEY_PREFIX');
  });

  it('creates the four VPC endpoints R34 names', async () => {
    // F34's cost point: NAT data processing scales with send volume, so
    // everything that can leave through an endpoint does.
    const network = await readFile(path.join(terraformRoot, 'modules/network/main.tf'), 'utf8');

    expect(network).toContain('aws_vpc_endpoint" "s3"');
    for (const service of ['ecr.api', 'ecr.dkr', 'secretsmanager', 'logs']) {
      expect(network, `missing endpoint for ${service}`).toContain(`"${service}"`);
    }
  });
});

describe('the data tier has no way out', () => {
  it('has a data route table with no default route', async () => {
    // The statement is the absence. A restrictive security group over a
    // routable subnet is a mistake somebody can make; a missing route is not
    // something that can be talked into working.
    const network = await readFile(path.join(terraformRoot, 'modules/network/main.tf'), 'utf8');
    const clean = withoutComments(network);

    const routes = [...clean.matchAll(/resource\s+"aws_route"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/gu)];
    const defaultRoutes = routes.filter(([, , body]) =>
      (body ?? '').includes('0.0.0.0/0'),
    );

    expect(defaultRoutes.length).toBeGreaterThan(0);
    for (const [, name] of defaultRoutes) {
      expect(name, `${name} gives the data tier a default route`).not.toContain('data');
    }
  });

  it('accepts only Postgres and Redis into the data group', async () => {
    const network = await readFile(path.join(terraformRoot, 'modules/network/main.tf'), 'utf8');
    const clean = withoutComments(network);

    const ingress = [
      ...clean.matchAll(
        /resource\s+"aws_vpc_security_group_ingress_rule"\s+"(data_[^"]+)"\s*\{([\s\S]*?)\n\}/gu,
      ),
    ];

    expect(ingress.length).toBe(2);
    const ports = ingress.map(([, , body]) => /from_port\s+=\s+(\d+)/u.exec(body ?? '')?.[1]);
    expect(ports.sort()).toEqual(['5432', '6379']);
  });
});

describe('storage is private and encrypted', () => {
  it('blocks public access on every bucket', async () => {
    const storage = await readFile(path.join(terraformRoot, 'modules/storage/main.tf'), 'utf8');

    expect(storage).toContain('aws_s3_bucket_public_access_block');
    for (const setting of [
      'block_public_acls       = true',
      'block_public_policy     = true',
      'ignore_public_acls      = true',
      'restrict_public_buckets = true',
    ]) {
      expect(storage).toContain(setting);
    }
  });

  it('encrypts the database, its snapshots and Redis', async () => {
    const data = await readFile(path.join(terraformRoot, 'modules/data/main.tf'), 'utf8');

    expect(data).toContain('storage_encrypted     = true');
    expect(data).toContain('at_rest_encryption_enabled = true');
    expect(data).toContain('transit_encryption_enabled = true');
  });

  it('keeps PITR on in both environments', async () => {
    // `backup_retention_period` above zero is what enables it, so the
    // validation on the variable is the guard rather than a comment.
    const variables = await readFile(path.join(terraformRoot, 'modules/data/variables.tf'), 'utf8');

    expect(variables).toContain('var.backup_retention_days >= 1');
  });

  it('refuses to evict a queued job', async () => {
    // `noeviction`. BullMQ keeps job state in Redis, and an eviction policy
    // deletes queued sends silently — the queue appears to drain and the
    // emails never go.
    const data = await readFile(path.join(terraformRoot, 'modules/data/main.tf'), 'utf8');

    expect(data).toContain('value = "noeviction"');
  });

  it('keeps image tags immutable', async () => {
    // CI promotes a digest. A mutable tag means the artifact that was tested
    // and the one that ships can differ while both answer to the same name.
    const storage = await readFile(path.join(terraformRoot, 'modules/storage/main.tf'), 'utf8');

    expect(storage).toContain('image_tag_mutability = "IMMUTABLE"');
  });
});

describe('deployment', () => {
  it('pins the image by digest, not by tag', async () => {
    // The *validation*, not a mention. The variable's description explains
    // the digest format, so a `toContain('@sha256:')` passes with the
    // validation block deleted — which is exactly the edit somebody makes
    // when a plan refuses their tag.
    for (const environment of ['production', 'staging']) {
      const variables = await readFile(
        path.join(terraformRoot, `environments/${environment}/variables.tf`),
        'utf8',
      );

      const image = /variable "image" \{([\s\S]*?)^\}/mu.exec(variables)?.[1] ?? '';
      const validation = /validation \{([\s\S]*?)^ {2}\}/mu.exec(image)?.[1] ?? '';

      expect(validation, `${environment} image variable has no validation`).toContain('condition');
      expect(validation, environment).toContain('@sha256:[0-9a-f]{64}$');
    }
  });

  it('runs the scheduler as a singleton', async () => {
    // Two schedulers both tick. The leader election in Postgres would
    // survive it, but a deployment that routinely runs two makes that lock
    // the only thing between us and duplicate scheduled sends.
    for (const environment of ['production', 'staging']) {
      const main = await readFile(
        path.join(terraformRoot, `environments/${environment}/main.tf`),
        'utf8',
      );

      const scheduler = /scheduler\s*=\s*\{([\s\S]*?)\n {4}\}/u.exec(main)?.[1] ?? '';

      expect(scheduler, environment).toContain('singleton     = true');
      expect(scheduler, environment).toContain('desired_count = 1');
      expect(scheduler, environment).toContain('max_count     = 1');
    }
  });

  it('stops the old scheduler before starting the new one', async () => {
    const compute = await readFile(path.join(terraformRoot, 'modules/compute/main.tf'), 'utf8');

    expect(compute).toContain('each.value.singleton ? 100 : 200');
    expect(compute).toContain('each.value.singleton ? 0 : 100');
  });

  it('health-checks the load balancer target on /ready, not /health', async () => {
    // docs/10: `/health` is process-alive only, so a target group watching it
    // keeps a task in service while it cannot reach Postgres. `/health/deep`
    // touches providers, so watching that drains the fleet when somebody
    // else's API is slow.
    const compute = await readFile(path.join(terraformRoot, 'modules/compute/main.tf'), 'utf8');
    const healthCheck = /health_check\s*\{([\s\S]*?)\n {2}\}/u.exec(compute)?.[1] ?? '';

    expect(healthCheck).toContain('path                = "/ready"');
  });

  it('gives a worker longer to stop than a web task', async () => {
    // A worker mid-provider-call killed at 30 seconds leaves a recipient in
    // the ambiguous state D3 is about.
    const compute = await readFile(path.join(terraformRoot, 'modules/compute/main.tf'), 'utf8');

    expect(compute).toContain('stopTimeout = each.value.path_patterns == null ? 120 : 30');
  });

  it('never runs migrations at container boot', async () => {
    // CLAUDE.md section 8. Twenty tasks booting simultaneously would race on
    // the migration table, so it is a one-off task with an explicit command.
    const compute = await readFile(path.join(terraformRoot, 'modules/compute/main.tf'), 'utf8');

    expect(compute).toContain('aws_ecs_task_definition" "migrate"');
    expect(compute).toContain('"node", "packages/db/dist/bin/migrate.js"');

    // And the four long-running services must not carry that command.
    const services = /resource "aws_ecs_task_definition" "this"[\s\S]*?\n\}/u.exec(compute)?.[0] ?? '';
    expect(services).not.toContain('migrate.js');
  });
});
