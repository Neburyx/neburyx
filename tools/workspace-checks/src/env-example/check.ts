import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '../architecture/tree.js';
import { collectEnvReads, type EnvRead } from './collect.js';

export const ENV_SCAN_ROOT = 'services/api/src';
/** Test support code that reads the developer's environment; it is not the API. */
export const ENV_SCAN_EXCLUDED: readonly string[] = ['services/api/src/testing', 'services/api/src/image', 'services/api/src/compose'];
/** The one file that reads the variable names a mapping gives for a source's login; its reads cannot be resolved by a scan, by design. */
export const CREDENTIAL_RESOLVER = 'services/api/src/sources/credentials.ts';
export const SECRET_VARIABLES: readonly string[] = ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'NEBURYX_CURSOR_KEY'];

export interface EnvViolation {
  readonly kind: 'unlisted' | 'unused' | 'unresolved' | 'undescribed' | 'secret-has-value';
  readonly name?: string;
  readonly file?: string;
  readonly line?: number;
}

const VARIABLE = /^(?:# ?)?([A-Z][A-Z0-9_]+)=(.*)$/;

export function readsOf(root: string): EnvRead[] {
  return loadTree(root, { include: [ENV_SCAN_ROOT], exclude: ENV_SCAN_EXCLUDED })
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file.path))
    .flatMap((file) => collectEnvReads(file));
}

function listedVariables(root: string): { name: string; value: string; described: boolean; line: number }[] {
  const lines = readFileSync(join(root, '.env.example'), 'utf8').split('\n');
  return lines.flatMap((line, index) => {
    const match = VARIABLE.exec(line);
    if (match?.[1] === undefined) return [];
    const above = lines[index - 1] ?? '';
    return [{ name: match[1], value: match[2] ?? '', described: above.startsWith('# ') && !VARIABLE.test(above), line: index + 1 }];
  });
}

/** The environment variables the API reads against the root `.env.example`, in both directions. */
export function checkEnvExample(root: string): EnvViolation[] {
  const violations: EnvViolation[] = [];
  const reads = readsOf(root);
  const read = new Set<string>();
  for (const entry of reads) {
    if (entry.name !== undefined) read.add(entry.name);
    else if (entry.file !== CREDENTIAL_RESOLVER) violations.push({ kind: 'unresolved', file: entry.file, line: entry.line });
  }
  const listed = listedVariables(root);
  const names = new Set(listed.map((entry) => entry.name));
  for (const name of [...read].sort()) {
    if (!names.has(name)) {
      const first = reads.find((entry) => entry.name === name);
      violations.push({ kind: 'unlisted', name, ...(first === undefined ? {} : { file: first.file, line: first.line }) });
    }
  }
  for (const entry of listed) {
    if (!read.has(entry.name)) violations.push({ kind: 'unused', name: entry.name, file: '.env.example', line: entry.line });
    if (!entry.described) violations.push({ kind: 'undescribed', name: entry.name, file: '.env.example', line: entry.line });
    if (SECRET_VARIABLES.includes(entry.name) && entry.value !== '') violations.push({ kind: 'secret-has-value', name: entry.name, file: '.env.example', line: entry.line });
  }
  return violations;
}

export function formatEnvViolations(violations: readonly EnvViolation[]): string {
  const where = (violation: EnvViolation): string => (violation.file === undefined ? '' : ` (${violation.file}${violation.line === undefined ? '' : `:${violation.line}`})`);
  const messages: Record<EnvViolation['kind'], string> = {
    unlisted: 'is read by the API and is not in .env.example',
    unused: 'is listed in .env.example and no source reads it',
    unresolved: 'an environment variable is read through a key the check cannot resolve; read it by a literal or a constant of the same file',
    undescribed: 'has no one-line description directly above it in .env.example',
    'secret-has-value': 'is a secret and has a value in .env.example',
  };
  return violations.map((violation) => `${violation.name ?? 'a variable'} ${messages[violation.kind]}${where(violation)}`).join('\n');
}
