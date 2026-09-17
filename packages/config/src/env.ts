import { z } from 'zod';

/**
 * The one and only read of `process.env` in the entire codebase.
 *
 * Enforced by the `relayd/no-process-env` lint rule (CLAUDE.md section 7),
 * which allows `process.env` inside `packages/config/**` and nowhere else.
 * Everything downstream receives a parsed, typed value.
 */
function readRawEnvironment(): Record<string, string | undefined> {
  return process.env;
}

/**
 * Thrown when the environment does not satisfy the schema. Carries every
 * problem at once: discovering six missing variables across six restarts is
 * the failure mode this avoids.
 */
export class EnvironmentError extends Error {
  override readonly name = 'EnvironmentError';

  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
  }
}

/**
 * Parses `process.env` against `schema`, failing fast and loudly.
 *
 * Call this once, at process start, before anything else runs. A process that
 * cannot configure itself must die immediately rather than serve traffic in a
 * half-configured state.
 */
export function parseEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(readRawEnvironment());

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvironmentError(issues);
  }

  return result.data as z.infer<T>;
}
