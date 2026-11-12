import { loadTree } from '../architecture/tree.js';
import { ALLOWLIST, type AllowlistEntry } from './allowlist.js';
import { readIdentifiers } from './packs.js';
import { findIdentifierLiterals, indexByName } from './scan.js';
import type { WordViolation } from './violations.js';

export const DOMAIN_WORD_SCAN_ROOTS: readonly string[] = ['services/api', 'apps/web', 'packages/contracts', 'ee/ask', 'ee/audit'];

/** Every pack identifier that the scanned code holds as a string literal, with no word allowed: the one pass over the tree that the checks below filter. */
export function scanDomainWords(root: string): WordViolation[] {
  const byName = indexByName(readIdentifiers(root));
  return loadTree(root, { include: DOMAIN_WORD_SCAN_ROOTS }).flatMap((file) => findIdentifierLiterals(file, byName));
}

export function withoutAllowedWords(violations: readonly WordViolation[], allowlist: readonly AllowlistEntry[]): WordViolation[] {
  const allowed = new Set(allowlist.map((entry) => entry.word));
  return violations.filter((violation) => !allowed.has(violation.word));
}

export function checkDomainWords(root: string, allowlist: readonly AllowlistEntry[] = ALLOWLIST): WordViolation[] {
  return withoutAllowedWords(scanDomainWords(root), allowlist);
}
