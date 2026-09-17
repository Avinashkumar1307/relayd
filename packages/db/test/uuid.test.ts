import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/uuid.js';

describe('uuidv7', () => {
  it('produces a version 7 uuid', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('sorts ascending by generation order, which is the point', () => {
    // Time-ordered keys land at the right-hand edge of the index instead of
    // scattering across it (CLAUDE.md section 8).
    const ids = Array.from({ length: 500 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not collide', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(10_000);
  });
});
