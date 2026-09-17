import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  WORKSPACE_ROLES,
  can,
  canApiKeyHold,
  partitionApiKeyScopes,
  permissionsFor,
  type Permission,
  type WorkspaceRole,
} from '../src/permissions.js';

/**
 * The matrix from docs/06 section 15, transcribed independently of the
 * implementation and asserted cell by cell.
 *
 * Written out in full rather than derived, deliberately: a test that computed
 * expectations from the same table it is checking would pass no matter what
 * that table said. This is the document, in test form.
 */
const DOCS_06_MATRIX: Record<Permission, Record<WorkspaceRole, boolean>> = {
  //                    owner  admin  editor viewer
  'workspace:read': { owner: true, admin: true, editor: true, viewer: true },
  'workspace:update': { owner: true, admin: true, editor: false, viewer: false },
  'workspace:delete': { owner: true, admin: false, editor: false, viewer: false },
  'member:invite': { owner: true, admin: true, editor: false, viewer: false },
  'member:remove': { owner: true, admin: true, editor: false, viewer: false },
  'contact:read': { owner: true, admin: true, editor: true, viewer: true },
  'contact:write': { owner: true, admin: true, editor: true, viewer: false },
  'contact:import': { owner: true, admin: true, editor: true, viewer: false },
  'contact:export': { owner: true, admin: true, editor: false, viewer: false },
  'template:write': { owner: true, admin: true, editor: true, viewer: false },
  'campaign:write': { owner: true, admin: true, editor: true, viewer: false },
  'campaign:launch': { owner: true, admin: true, editor: false, viewer: false },
  'provider:read': { owner: true, admin: true, editor: true, viewer: true },
  'provider:write': { owner: true, admin: true, editor: false, viewer: false },
  'billing:read': { owner: true, admin: true, editor: false, viewer: false },
  'billing:write': { owner: true, admin: false, editor: false, viewer: false },
  'apikey:write': { owner: true, admin: true, editor: false, viewer: false },
  'audit:read': { owner: true, admin: true, editor: false, viewer: false },
};

describe('permission matrix matches docs/06 section 15', () => {
  it('covers exactly the documented permissions, with none invented or missing', () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(DOCS_06_MATRIX).sort());
  });

  it('has the four preset roles', () => {
    expect([...WORKSPACE_ROLES]).toEqual(['owner', 'admin', 'editor', 'viewer']);
  });

  for (const [permission, expected] of Object.entries(DOCS_06_MATRIX)) {
    for (const [role, allowed] of Object.entries(expected)) {
      it(`${role} ${allowed ? 'has' : 'does not have'} ${permission}`, () => {
        expect(can(role as WorkspaceRole, permission as Permission)).toBe(allowed);
      });
    }
  }
});

describe('the two rules CLAUDE.md section 11 singles out', () => {
  it('separates campaign:launch from campaign:write', () => {
    // An editor may build a campaign and may not send it to 50,000 people.
    expect(can('editor', 'campaign:write')).toBe(true);
    expect(can('editor', 'campaign:launch')).toBe(false);
  });

  it('keeps billing:write to the owner, not admins', () => {
    expect(can('owner', 'billing:write')).toBe(true);
    expect(can('admin', 'billing:write')).toBe(false);
    // Admins can still see the bill.
    expect(can('admin', 'billing:read')).toBe(true);
  });
});

describe('role shape', () => {
  it('gives owner everything', () => {
    expect(permissionsFor('owner').sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives viewer read-only access and nothing that mutates', () => {
    for (const permission of permissionsFor('viewer')) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('is monotonic: owner ⊇ admin, and admin ⊇ editor is not assumed', () => {
    const owner = new Set(permissionsFor('owner'));
    const admin = permissionsFor('admin');
    expect(admin.every((p) => owner.has(p))).toBe(true);

    // editor holds contact:write, which admin also holds; but editor is NOT a
    // subset relationship worth asserting in general, because editor holds
    // nothing admin lacks. Assert that explicitly rather than assuming it.
    const adminSet = new Set(admin);
    expect(permissionsFor('editor').every((p) => adminSet.has(p))).toBe(true);
    expect(permissionsFor('viewer').every((p) => adminSet.has(p))).toBe(true);
  });
});

describe('API key restrictions', () => {
  it('never lets a key hold billing:write', () => {
    expect(canApiKeyHold('billing:write')).toBe(false);
  });

  it('allows every other permission on a key', () => {
    for (const permission of PERMISSIONS) {
      if (permission === 'billing:write') continue;
      expect(canApiKeyHold(permission)).toBe(true);
    }
  });

  it('reports what it refused rather than silently downgrading a key', () => {
    const { allowed, refused } = partitionApiKeyScopes([
      'campaign:write',
      'billing:write',
      'contact:read',
    ]);

    expect(allowed).toEqual(['campaign:write', 'contact:read']);
    expect(refused).toEqual(['billing:write']);
  });
});

describe('matrix immutability', () => {
  it('cannot be widened at runtime', () => {
    const before = permissionsFor('viewer');
    // permissionsFor returns a copy; mutating it must not affect the matrix.
    permissionsFor('viewer').push('billing:write');
    expect(permissionsFor('viewer')).toEqual(before);
    expect(can('viewer', 'billing:write')).toBe(false);
  });
});
