import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SCOPE_TYPE,
  scanRepositories,
  scanRepositorySource,
} from '../src/repository-scope-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const REPO_FILE = 'packages/db/src/repositories/contacts.ts';
const GLOBAL_FILE = 'packages/db/src/repositories/global/workspaces.ts';

const names = (file: string, source: string) =>
  scanRepositorySource(file, source).map((m) => `${m.name}:${m.compliant ? 'ok' : 'BAD'}`);

/**
 * The detector is tested against fixtures because the real scan is vacuous
 * until checklist item 4 creates the first repository. Without these, this
 * file would pass for weeks while proving nothing.
 */
describe('repository scope detector', () => {
  it('accepts a method whose first parameter is WorkspaceScope', () => {
    const source = `
      export class ContactRepository {
        async findById(scope: WorkspaceScope, id: string) { return null; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.findById:ok']);
  });

  it('rejects a method whose first parameter is something else', () => {
    const source = `
      export class ContactRepository {
        async findById(id: string, scope: WorkspaceScope) { return null; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.findById:BAD']);
  });

  it('rejects a method with no parameters at all', () => {
    const source = `
      export class ContactRepository {
        async countAll() { return 0; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.countAll:BAD']);
  });

  it('rejects an untyped first parameter', () => {
    const source = `
      export class ContactRepository {
        async findById(scope, id: string) { return null; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.findById:BAD']);
  });

  it('catches exported functions, not just class methods', () => {
    const source = `
      export function findById(id: string) { return null; }
      export const listAll = (scope: WorkspaceScope) => [];
    `;
    expect(names(REPO_FILE, source)).toEqual(['findById:BAD', 'listAll:ok']);
  });

  it('ignores private and protected members', () => {
    const source = `
      export class ContactRepository {
        private buildQuery(id: string) { return id; }
        protected mapRow(row: unknown) { return row; }
        #secret(id: string) { return id; }
        async findById(scope: WorkspaceScope, id: string) { return null; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.findById:ok']);
  });

  it('ignores a class that is not exported', () => {
    const source = `
      class Helper {
        run(id: string) { return id; }
      }`;
    expect(names(REPO_FILE, source)).toEqual([]);
  });

  it('exempts cross-tenant repositories under global/', () => {
    const source = `
      export class WorkspaceRepository {
        async findBySlug(slug: string) { return null; }
      }`;
    expect(names(GLOBAL_FILE, source)).toEqual(['WorkspaceRepository.findBySlug:ok']);
  });

  it('requires exactly the branded type, not a lookalike', () => {
    const source = `
      export class ContactRepository {
        async findById(scope: { workspaceId: string }, id: string) { return null; }
      }`;
    expect(names(REPO_FILE, source)).toEqual(['ContactRepository.findById:BAD']);
    expect(REQUIRED_SCOPE_TYPE).toBe('WorkspaceScope');
  });
});

describe('repository scope across packages/db', () => {
  /**
   * TRIPWIRE. There are no repositories yet — checklist item 4 creates them —
   * so the sweep below is vacuous today. This test asserts that vacuity
   * explicitly, so that the moment the first repository lands it FAILS and
   * forces whoever adds it to flip the assertion, rather than letting a
   * permanently empty scan read as a passing proof.
   */
  it('has no repositories yet: flip this when checklist item 4 lands', async () => {
    const { present, methods } = await scanRepositories(repoRoot);
    expect({ present, methodCount: methods.length }).toEqual({
      present: false,
      methodCount: 0,
    });
  });

  it('every repository method takes WorkspaceScope first', async () => {
    const { violations } = await scanRepositories(repoRoot);
    expect(
      violations.map((v) => `${v.file} ${v.name} first param: ${v.firstParameterType ?? 'none'}`),
    ).toEqual([]);
  });
});
