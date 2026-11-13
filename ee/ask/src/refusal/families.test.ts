import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASK_REFUSAL_FAMILIES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_SENTENCE_LENGTH, MODEL_FAMILIES, REFUSAL_SENTENCES, fixedRefusal, isModelFamily } from './families.js';

const PACKS = fileURLToPath(new URL('../../../../domain-packs', import.meta.url));

/** Every entity type, label, relationship type and property key a pack's mapping names, split into lowercase words. */
function packWords(): ReadonlySet<string> {
  const words = new Set<string>();
  for (const pack of readdirSync(PACKS, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const text = readFileSync(`${PACKS}/${pack.name}/neburyx.yaml`, 'utf8');
    for (const match of text.matchAll(/^\s*-?\s*(?:type|label|key|property|name):\s*([A-Za-z_]+)\s*$/gm)) {
      for (const word of (match[1] ?? '').split(/[_]|(?<=[a-z])(?=[A-Z])/)) if (word.length > 2) words.add(word.toLowerCase());
    }
  }
  return words;
}

const TOOL_NAMES = /\b(Filters|Search|Expand|Paths|Inspect)\b/;

describe('the fixed sentences', () => {
  it('has one sentence for every family of the closed list, and none besides', () => {
    expect(Object.keys(REFUSAL_SENTENCES).sort()).toEqual([...ASK_REFUSAL_FAMILIES].sort());
  });

  it.each(ASK_REFUSAL_FAMILIES)('%s holds no placeholder mark, digit run, ID shape or tool name and is short', (family) => {
    const sentence = REFUSAL_SENTENCES[family];
    expect(sentence).not.toMatch(/[‹›]/);
    expect(sentence).not.toMatch(/[0-9]/);
    expect(sentence).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}\b/i);
    expect(sentence).not.toMatch(TOOL_NAMES);
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence.length).toBeLessThanOrEqual(MAX_SENTENCE_LENGTH);
  });

  it('holds no word a domain pack names as a type, label or key', () => {
    const words = packWords();
    expect(words.size).toBeGreaterThan(5);
    for (const family of ASK_REFUSAL_FAMILIES) {
      for (const word of REFUSAL_SENTENCES[family].toLowerCase().split(/[^a-z]+/)) expect(words.has(word), `${family}: ${word}`).toBe(false);
    }
  });

  it('keeps the two server-only families out of what the model may name', () => {
    expect(MODEL_FAMILIES).not.toContain('plan-not-usable');
    expect(MODEL_FAMILIES).not.toContain('model-refused');
    expect(isModelFamily('path')).toBe(true);
    expect(isModelFamily('model-refused')).toBe(false);
    expect(isModelFamily('nonsense')).toBe(false);
    expect(isModelFamily(3)).toBe(false);
  });
});

describe('the refusal made of a family', () => {
  it('uses the family given and its sentence', () => {
    expect(fixedRefusal('judgement')).toEqual({ kind: 'unsupported', family: 'judgement', reason: REFUSAL_SENTENCES.judgement });
  });

  it('falls back to other for a family that is not on the list', () => {
    expect(fixedRefusal('made-up' as never)).toEqual(fixedRefusal(undefined));
  });

  it('falls back to other when no family is given', () => {
    expect(fixedRefusal(undefined)).toEqual({ kind: 'unsupported', family: 'other', reason: REFUSAL_SENTENCES.other });
  });
});
