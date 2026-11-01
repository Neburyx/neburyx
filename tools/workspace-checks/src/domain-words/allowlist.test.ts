import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { ALLOWLIST } from './allowlist.js';
import { checkDomainWords } from './check.js';
import { makeRoot, packText } from './fixtures.js';
import { readIdentifiers } from './packs.js';

describe('the allowlist', () => {
  it('gives every entry a word and a written reason, and lists no word twice', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.word).toMatch(/^\S+$/);
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
    expect(new Set(ALLOWLIST.map((entry) => entry.word)).size).toBe(ALLOWLIST.length);
  });

  it('holds only words that are identifiers of a shipped pack', () => {
    const identifiers = new Set(readIdentifiers(repoRoot).map((identifier) => identifier.name));
    expect(ALLOWLIST.filter((entry) => !identifiers.has(entry.word)).map((entry) => entry.word)).toEqual([]);
  });

  it('holds only words the scanned code still uses as a string literal, so an entry nothing uses has to go', () => {
    const used = new Set(checkDomainWords(repoRoot, []).map((violation) => violation.word));
    expect(ALLOWLIST.filter((entry) => !used.has(entry.word)).map((entry) => entry.word)).toEqual([]);
  });
});

describe('an allowlisted word', () => {
  const files = {
    'domain-packs/sample/neburyx.yaml': packText([['widget', 'Widget']], ['MADE_BY']),
    'services/api/src/a.ts': "export const kind = ['widget', 'MADE_BY'];\n",
  };

  it('is not reported, and is reported again once it is off the list', () => {
    const root = makeRoot(files);
    const entry = { word: 'widget', reason: 'a word the product itself uses' };
    expect(checkDomainWords(root, [entry]).map((violation) => violation.word)).toEqual(['MADE_BY']);
    expect(checkDomainWords(root, []).map((violation) => violation.word)).toEqual(['widget', 'MADE_BY']);
  });
});
