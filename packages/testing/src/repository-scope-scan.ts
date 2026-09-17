import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/**
 * CLAUDE.md section 6.2: "Every repository method takes a branded
 * WorkspaceScope as its FIRST parameter. A CI reflection test enumerates all
 * repository methods and fails if any lacks it. No exceptions except
 * explicitly named cross-tenant repositories in
 * packages/db/repositories/global/."
 *
 * Reflection in the literal sense is impossible: TypeScript types do not exist
 * at runtime, so there is nothing to reflect over. This reads the source with
 * the TypeScript compiler API instead, which has the advantage of catching a
 * method that would never be called in any test.
 */

/** Both documented layouts, as with the ESLint rules. */
export const REPOSITORY_DIRS = [
  'packages/db/repositories',
  'packages/db/src/repositories',
];

/** The required first-parameter type. */
export const REQUIRED_SCOPE_TYPE = 'WorkspaceScope';

/** Cross-tenant repositories, exempt by name and location only. */
const GLOBAL_SEGMENT = '/global/';

export interface RepositoryMethod {
  file: string;
  name: string;
  firstParameterType: string | undefined;
  isGlobal: boolean;
  compliant: boolean;
}

export interface RepositoryScan {
  /** False until checklist item 4 creates the directory. */
  present: boolean;
  methods: RepositoryMethod[];
  violations: RepositoryMethod[];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
    : false;
}

const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);

function parameterTypeText(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  source: ts.SourceFile,
): string | undefined {
  const first = parameters[0];
  if (first?.type === undefined) return undefined;
  return first.type.getText(source).trim();
}

/** Enumerates the exported methods and functions of one repository file. */
export function scanRepositorySource(relativePath: string, source: string): RepositoryMethod[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.ES2023,
    true,
  );
  const isGlobal = `/${relativePath}`.includes(GLOBAL_SEGMENT);
  const found: RepositoryMethod[] = [];

  const record = (name: string, type: string | undefined): void => {
    found.push({
      file: relativePath,
      name,
      firstParameterType: type,
      isGlobal,
      // A global repository is cross-tenant by definition and exempt.
      compliant: isGlobal || type === REQUIRED_SCOPE_TYPE,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && isExported(statement)) {
      const className = statement.name?.getText(sourceFile) ?? '(anonymous class)';
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
        if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
        if (ts.isPrivateIdentifier(member.name)) continue;
        record(
          `${className}.${member.name.getText(sourceFile)}`,
          parameterTypeText(member.parameters, sourceFile),
        );
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) {
      record(
        statement.name.getText(sourceFile),
        parameterTypeText(statement.parameters, sourceFile),
      );
      continue;
    }

    // export const findById = (scope: WorkspaceScope, ...) => ...
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer === undefined) continue;
        if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
        record(
          declaration.name.getText(sourceFile),
          parameterTypeText(initializer.parameters, sourceFile),
        );
      }
    }
  }

  return found;
}

async function listTypeScriptFiles(absolute: string, repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(absolute, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    if (entry.name.includes('.test.')) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.push(path.relative(repoRoot, full).replaceAll(path.sep, '/'));
  }
  return out.sort();
}

export async function scanRepositories(repoRoot: string): Promise<RepositoryScan> {
  const methods: RepositoryMethod[] = [];
  let present = false;

  for (const dir of REPOSITORY_DIRS) {
    const absolute = path.join(repoRoot, dir);
    let files: string[];
    try {
      files = await listTypeScriptFiles(absolute, repoRoot);
    } catch {
      continue; // directory does not exist yet
    }
    present = true;
    for (const file of files) {
      const source = await readFile(path.join(repoRoot, file), 'utf8');
      methods.push(...scanRepositorySource(file, source));
    }
  }

  return { present, methods, violations: methods.filter((m) => !m.compliant) };
}
