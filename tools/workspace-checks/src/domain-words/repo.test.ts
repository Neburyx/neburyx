import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { ALLOWLIST } from './allowlist.js';
import { scanDomainWords, withoutAllowedWords } from './check.js';
import { formatWordViolations, type WordViolation } from './violations.js';

// One pass over the product directories serves both tests.

let scanned: WordViolation[] = [];

beforeAll(() => {
  scanned = scanDomainWords(repoRoot);
});

describe('the repository', () => {
  it('holds no pack identifier as a string literal in the product directories', () => {
    expect(formatWordViolations(withoutAllowedWords(scanned, ALLOWLIST))).toBe('');
  });

  it('holds only allowlisted words that the scanned code still uses as a string literal, so an entry nothing uses has to go', () => {
    const used = new Set(scanned.map((violation) => violation.word));
    expect(ALLOWLIST.filter((entry) => !used.has(entry.word)).map((entry) => entry.word)).toEqual([]);
  });
});
