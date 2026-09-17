import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvironmentError, parseEnv } from '../src/env.js';
import { baseEnv, postgresEnv, redisEnv } from '../src/schema.js';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe('parseEnv', () => {
  it('fails fast when a required variable is missing', () => {
    process.env = {};
    expect(() => parseEnv(postgresEnv)).toThrow(EnvironmentError);
  });

  it('reports every problem at once, not just the first', () => {
    process.env = {};
    let issues: readonly string[] = [];
    try {
      parseEnv(postgresEnv.merge(redisEnv));
    } catch (error) {
      issues = (error as EnvironmentError).issues;
    }
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('DATABASE_URL');
    expect(issues.join('\n')).toContain('REDIS_URL');
  });

  it('rejects a URL with the wrong scheme', () => {
    process.env = { DATABASE_URL: 'mysql://localhost:3306/relayd' };
    expect(() => parseEnv(postgresEnv)).toThrow(/postgresql:\/\/ URL/);
  });

  it('applies documented defaults', () => {
    process.env = {};
    expect(parseEnv(baseEnv)).toEqual({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });

  it('coerces and returns typed values', () => {
    process.env = { DATABASE_URL: 'postgres://user:pw@localhost:5432/relayd' };
    const env = parseEnv(postgresEnv.merge(z.object({ PORT: z.coerce.number().default(3000) })));
    expect(env.DATABASE_URL).toBe('postgres://user:pw@localhost:5432/relayd');
    expect(env.PORT).toBe(3000);
  });
});
