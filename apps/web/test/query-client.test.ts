import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../src/query-client.js';

type RetryFn = (failureCount: number, error: unknown) => boolean;

describe('query client', () => {
  const retry = () =>
    createQueryClient().getDefaultOptions().queries?.retry as RetryFn;

  it('does not retry a 4xx, which will not become true on a second try', () => {
    expect(retry()(0, { status: 404 })).toBe(false);
    expect(retry()(0, { status: 403 })).toBe(false);
  });

  it('retries a server error once', () => {
    expect(retry()(0, { status: 500 })).toBe(true);
    expect(retry()(1, { status: 500 })).toBe(false);
  });

  it('retries a network error with no status once', () => {
    expect(retry()(0, new Error('network down'))).toBe(true);
  });
});
