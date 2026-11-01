import { loadTree } from '../architecture/tree.js';
import { ALLOWLIST, type AllowlistEntry } from './allowlist.js';
import { readIdentifiers } from './packs.js';
import { findIdentifierLiterals, indexByName } from './scan.js';
import type { WordViolation } from './violations.js';

export const DOMAIN_WORD_SCAN_ROOTS: readonly string[] = ['services/api', 'apps/web', 'packages/contracts'];

export function checkDomainWords(root: string, allowlist: readonly AllowlistEntry[] = ALLOWLIST): WordViolation[] {
  const allowed = new Set(allowlist.map((entry) => entry.word));
  const byName = indexByName(readIdentifiers(root).filter((identifier) => !allowed.has(identifier.name)));
  return loadTree(root, { include: DOMAIN_WORD_SCAN_ROOTS }).flatMap((file) => findIdentifierLiterals(file, byName));
}
