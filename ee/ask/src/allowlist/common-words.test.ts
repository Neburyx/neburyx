import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMON_WORDS } from './common-words.js';
import * as entry from './index.js';
import { FUNCTION_WORDS, ORDINARY_WORDS_ALSO_SURNAMES } from './function-words.js';
import { rebuildPlannerText } from './rebuild.js';

const NAMES = fileURLToPath(new URL('../testing/names/census-2010-surnames.txt', import.meta.url));
const INDEX = fileURLToPath(new URL('./index.ts', import.meta.url));
const SOURCE = fileURLToPath(new URL('.', import.meta.url));

const PINNED_VERSION = 'common-words-2';
const PINNED_HASH = 'b15610934c6f6e7b8b2e35bf89a5037a704c64b0d49ef710e7c842d562e5fa16';

const MIN_SURNAMES = 100_000;

function surnames(path: string = NAMES): ReadonlySet<string> {
  const names = new Set(readFileSync(path, 'utf8').split('\n').filter((line) => line !== ''));
  if (names.size < MIN_SURNAMES) throw new Error('the surname list is too short');
  return names;
}

describe('the surname list used by the checks', () => {
  it('fails, and never skips, when the list is missing, empty or too short', () => {
    expect(() => surnames(`${NAMES}.missing`)).toThrow();
    const folder = mkdtempSync(join(tmpdir(), 'surnames-'));
    try {
      writeFileSync(join(folder, 'empty.txt'), '');
      writeFileSync(join(folder, 'short.txt'), 'smith\njones\n');
      expect(() => surnames(join(folder, 'empty.txt'))).toThrow('too short');
      expect(() => surnames(join(folder, 'short.txt'))).toThrow('too short');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    expect(surnames().size).toBeGreaterThan(MIN_SURNAMES);
  });
});

describe('the common-word list', () => {
  it('holds no word that is a surname of the public list, except the closed set of function words and the named ordinary words', () => {
    const names = surnames();
    const allowed = new Set([...FUNCTION_WORDS, ...ORDINARY_WORDS_ALSO_SURNAMES]);
    expect(COMMON_WORDS.filter((word) => names.has(word) && !allowed.has(word))).toEqual([]);
  });

  it('holds only the function words that are listed, and every one of them is on the list', () => {
    expect(FUNCTION_WORDS.filter((word) => !COMMON_WORDS.includes(word))).toEqual([]);
    expect(new Set(FUNCTION_WORDS).size).toBe(FUNCTION_WORDS.length);
  });

  it('keeps the seven named ordinary words, which are surnames, and no other word is allowed that way', () => {
    const names = surnames();
    expect([...ORDINARY_WORDS_ALSO_SURNAMES]).toEqual(['chain', 'made', 'money', 'payment', 'screen', 'show', 'shows']);
    for (const word of ORDINARY_WORDS_ALSO_SURNAMES) {
      expect(names.has(word)).toBe(true);
      expect(COMMON_WORDS).toContain(word);
      expect(FUNCTION_WORDS).not.toContain(word);
      expect(rebuildPlannerText({ text: word, spans: [], vocabulary: [] })).toEqual({ kind: 'rebuilt', text: word });
    }
  });

  it('has only lowercase ASCII letters, no duplicate, in sorted order', () => {
    expect(COMMON_WORDS.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    expect(new Set(COMMON_WORDS).size).toBe(COMMON_WORDS.length);
    expect([...COMMON_WORDS]).toEqual([...COMMON_WORDS].sort());
  });

  it('keeps its version in step with its content', () => {
    const hash = createHash('sha256').update(COMMON_WORDS.join('\n')).digest('hex');
    expect({ version: entry.COMMON_WORDS_VERSION, hash }).toEqual({ version: PINNED_VERSION, hash: PINNED_HASH });
  });

  it('names the public list, its publisher, its edition, its terms and the residual risks in the version note', () => {
    for (const part of ['Census Bureau', '2010 Census', 'downloaded', 'Licence terms', 'Given names: not yet removed', 'date of birth', 'adverbs not, here, very, now', 'ORDINARY_WORDS_ALSO_SURNAMES', '2026-11-13']) expect(entry.COMMON_WORDS_NOTE).toContain(part);
  });
});

describe('the list as the rebuild uses it', () => {
  it('blocks rose and hunter, which are surnames and not function words', () => {
    for (const word of ['rose', 'hunter']) expect(rebuildPlannerText({ text: word, spans: [], vocabulary: [] })).toEqual({ kind: 'blocked', tokens: [{ text: word, start: 0, end: word.length }] });
  });

  it('allows a question of function words and listed words, and blocks an unlisted word', () => {
    expect(rebuildPlannerText({ text: 'which of the same', spans: [], vocabulary: [] })).toEqual({ kind: 'rebuilt', text: 'which of the same' });
    expect(rebuildPlannerText({ text: 'which zorvath', spans: [], vocabulary: [] })).toMatchObject({ kind: 'blocked' });
  });

  it('has no number word, so a number above three digits cannot be spelled out', () => {
    expect(COMMON_WORDS.filter((word) => /^(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|million)$/.test(word))).toEqual([]);
    expect(rebuildPlannerText({ text: 'twenty five hundred', spans: [], vocabulary: [] })).toMatchObject({ kind: 'blocked' });
  });

  it('is bound inside the module: the package entry exports no way to pass a list', () => {
    const source = readFileSync(INDEX, 'utf8');
    expect(source).not.toContain('rebuildWithWords');
    expect(source).not.toContain('runQuestionWordsCommandWith');
    expect(source).not.toContain('checkQuestionWords');
    const importers = readdirSync(SOURCE).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && readFileSync(join(SOURCE, file), 'utf8').includes('rebuildWithWords'));
    expect(importers.sort()).toEqual(['question-words.ts', 'rebuild.ts']);
    expect(Object.keys(entry).sort()).toEqual(['AllowlistInputError', 'COMMON_WORDS_NOTE', 'COMMON_WORDS_VERSION', 'allowedWords', 'rebuildPlannerText', 'runQuestionWordsCommand']);
  });
});
