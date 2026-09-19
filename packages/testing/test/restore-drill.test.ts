import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The restore drill's refusals (BUILD-PLAN Phase 10; docs/10 "Backups and
 * disaster recovery"; docs/runbooks/restore-drill.md).
 *
 * ## What is tested, and what cannot be
 *
 * The drill itself needs an AWS account with a live RDS instance. It has not
 * been executed — this repository has never been deployed — and the
 * BUILD-PLAN box stays unticked for that reason.
 *
 * What *can* be tested is the part that turns a drill into an outage: the
 * refusals. `scripts/dr/restore-drill.sh` must not be able to delete or
 * restore over the live instance, and that guard has to hold on the worst
 * night of the year, typed by somebody who has not read the script.
 *
 * So the script is actually executed here, with `aws`, `jq` and `psql`
 * replaced by stubs that fail loudly if they are ever reached. A guard that
 * fires only *after* an API call is not a guard, and stubbing this way is
 * the difference between proving the refusal happens and proving the word
 * "refusing" appears in the file.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const script = path.join(repoRoot, 'scripts/dr/restore-drill.sh');

let stubBin: string;

beforeAll(() => {
  stubBin = mkdtempSync(path.join(tmpdir(), 'relayd-drill-'));

  // Anything that would reach AWS or a database exits non-zero with a
  // recognisable marker. If a marker shows up in the output of a test below,
  // the guard let the call through.
  for (const name of ['aws', 'jq', 'psql']) {
    const file = path.join(stubBin, name);
    writeFileSync(file, `#!/usr/bin/env bash\necho "STUB_CALLED:${name} $*" >&2\nexit 97\n`, {
      mode: 0o755,
    });
  }
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: {
      /* eslint-disable relayd/no-process-env --
       * The rule exists so application code cannot read configuration from
       * the environment (CLAUDE.md section 7); `packages/config` is the one
       * parser. This is neither: it is the OS `PATH`, needed to locate
       * `bash` itself and to put the stub directory ahead of it. Routing
       * that through a config schema would put the operating system's search
       * path into the application's config surface, which is a worse thing
       * to own than this comment.
       */
      ...process.env,
      PATH: `${stubBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
      /* eslint-enable relayd/no-process-env */
      ENVIRONMENT: 'production',
      ...env,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('the script runs at all', () => {
  it('prints usage for an unknown command', () => {
    // The tripwire. Every refusal below asserts a non-zero exit, and a
    // script that failed to start would satisfy all of them for the wrong
    // reason.
    const { status, output } = run(['nonsense']);

    expect(status).toBe(2);
    expect(output).toContain('usage:');
  });

  it('reaches AWS for a command that is supposed to', () => {
    // The positive control, and the one that gives the refusals their
    // meaning: `plan` is allowed to call out, so the stub marker must
    // appear. Without this, a script that refused everything — or that
    // could not find its own helpers — would pass every test in this file.
    const { output } = run(['plan']);

    expect(output).toContain('STUB_CALLED:aws');
  });
});

describe('cleanup cannot delete the live instance', () => {
  it('refuses an identifier with no drill marker', () => {
    const { status, output } = run(['cleanup', 'relayd-production']);

    expect(status).not.toBe(0);
    expect(output).toContain('refusing to delete');
  });

  it('refuses before calling AWS, not after', () => {
    // A guard that fires after the delete request has been sent is not a
    // guard. This is the assertion that says so.
    const { output } = run(['cleanup', 'relayd-production']);

    expect(output).not.toContain('STUB_CALLED');
  });

  it('refuses a name that merely looks similar', () => {
    // `-drill` without the trailing dash is not the pattern the script
    // creates, and an instance somebody named by hand is exactly the one
    // worth being strict about.
    for (const name of ['relayd-production-drill', 'drill', 'relayd-staging']) {
      const { status } = run(['cleanup', name]);

      expect(status, name).not.toBe(0);
    }
  });

  it('allows a real drill identifier through to AWS', () => {
    // The other side of the boundary. Without this, a `case` that refused
    // everything would pass every test above.
    const { output } = run(['cleanup', 'relayd-production-drill-20260919']);

    expect(output).toContain('STUB_CALLED:aws');
  });
});

describe('restore cannot target the live instance', () => {
  it('refuses a target with no marker', () => {
    const { status, output } = run([
      'restore',
      '2026-09-19T11:00:00Z',
      '--identifier',
      'relayd-production',
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('refusing target');
  });

  it('refuses before calling AWS', () => {
    const { output } = run([
      'restore',
      '2026-09-19T11:00:00Z',
      '--identifier',
      'relayd-production',
    ]);

    expect(output).not.toContain('STUB_CALLED');
  });

  it('accepts a recovery identifier, which a real incident needs', () => {
    // docs/runbooks/disaster-recovery.md restores into
    // `relayd-production-recovery` during situation B. If the guard refused
    // that, the runbook would be unfollowable at the moment it is needed.
    const { output } = run([
      'restore',
      '2026-09-19T11:00:00Z',
      '--identifier',
      'relayd-production-recovery',
    ]);

    expect(output).toContain('STUB_CALLED');
  });
});

describe('the script has no way to restore in place', () => {
  it('only ever calls the point-in-time restore, which creates a new instance', () => {
    // Read from the source, because there is no way to observe the absence
    // of a code path by running it. `restore-db-instance-to-point-in-time`
    // has no in-place mode; `modify-db-instance` and `promote-read-replica`
    // would be ways to affect the live one.
    const source = readFileSync(script, 'utf8');

    expect(source).toContain('restore-db-instance-to-point-in-time');
    expect(source).not.toContain('modify-db-instance');
    expect(source).not.toContain('promote-read-replica');
  });

  it('offers no force or override flag', () => {
    // The override is what somebody reaches for at 3am when the live
    // instance is the one they meant all along.
    const source = readFileSync(script, 'utf8');

    expect(source).not.toMatch(/--force\b/u);
    expect(source).not.toMatch(/RELAYD_ALLOW|SKIP_GUARD|--yes\b/u);
  });
});

describe('the runbooks say what has and has not happened', () => {
  it('records that no drill has been run', () => {
    // The drill log must not imply a drill happened. An empty table with a
    // tick next to it is how an untested backup gets treated as tested.
    const runbook = readFileSync(path.join(repoRoot, 'docs/runbooks/restore-drill.md'), 'utf8');

    expect(runbook).toContain('No drill has been run');
  });

  it('names the target in the row where the total is written down', () => {
    // In the recording table specifically, not somewhere in the prose. The
    // person filling that table in is the one who needs to know whether the
    // number they just wrote is a pass — and a drill whose result nobody
    // can judge is a drill nobody acts on.
    const runbook = readFileSync(path.join(repoRoot, 'docs/runbooks/restore-drill.md'), 'utf8');

    const totalRow = runbook.split('\n').find((line) => /^\|\s*\*\*Total/u.test(line));

    expect(totalRow, 'no Total row in the recording table').toBeDefined();
    expect(totalRow).toMatch(/60\s*min/u);
  });

  it('tells the reader never to restore over production', () => {
    for (const name of ['README.md', 'restore-drill.md', 'disaster-recovery.md']) {
      const runbook = readFileSync(path.join(repoRoot, 'docs/runbooks', name), 'utf8');

      expect(runbook.toLowerCase(), name).toContain('restore over production');
    }
  });
});
