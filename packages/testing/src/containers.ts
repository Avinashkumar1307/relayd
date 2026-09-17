import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { ciEnv, parseEnv } from '@relayd/config';

/**
 * Real Postgres and real Redis, per test run, thrown away afterwards.
 *
 * Versions match docs/10 and the local compose stack: Postgres 16, Redis 7.
 * An integration suite that runs against a different major than production is
 * testing something nobody ships.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';

export interface StartedPostgres {
  url: string;
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

export interface StartedRedis {
  url: string;
  container: StartedRedisContainer;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('relayd')
    .withUsername('relayd')
    .withPassword('relayd')
    .start();

  return {
    url: container.getConnectionUri(),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    url: container.getConnectionUrl(),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Whether a Docker daemon is reachable.
 *
 * Testcontainers throws a long, indirect error when it is not; probing once up
 * front turns that into a clear skip or a clear failure.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const { getContainerRuntimeClient } = (await import('testcontainers')) as {
      getContainerRuntimeClient: () => Promise<unknown>;
    };
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

/** True when running under a CI provider. */
export function isCI(): boolean {
  return parseEnv(ciEnv).CI;
}

export interface IntegrationGate {
  available: boolean;
  reason: string;
}

/**
 * Decides whether the integration suite runs.
 *
 * Locally, no Docker means skip with a message. In CI, no Docker means throw:
 * a silently skipped integration suite in CI is indistinguishable from a
 * passing one, which is the failure mode worth preventing.
 */
export async function requireContainers(): Promise<IntegrationGate> {
  const available = await isDockerAvailable();
  if (available) return { available, reason: '' };

  const reason =
    'Docker is not reachable; integration tests need a running daemon.';
  if (isCI()) {
    throw new Error(`${reason} Refusing to skip in CI.`);
  }
  return { available: false, reason };
}
