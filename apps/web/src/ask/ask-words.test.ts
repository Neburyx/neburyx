import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_COPY, CANCELLED_TEXT, FAILURE_TITLES } from './copy.js';
import { CHIP_LABELS, EXPAND_HINT } from './refusal-chips.js';

const OLD_WORDS = /\b(plan|plans|planner|preview|template|templates)\b/i;

describe('the words of the Ask panel', () => {
  it('hold none of the words of the old preview', () => {
    const words = [...Object.values(ASK_COPY), ...Object.values(FAILURE_TITLES), CANCELLED_TEXT, ...Object.values(CHIP_LABELS), EXPAND_HINT];
    expect(words.filter((text) => OLD_WORDS.test(text))).toEqual([]);
  });

  it('are not in the names of the files, the classes or the comments of the Ask folder', () => {
    const folder = __dirname;
    const files = readdirSync(folder).filter((name) => !name.includes('.test.'));
    expect(files.filter((name) => /plan|preview/i.test(name))).toEqual([]);
    for (const name of files) {
      const text = readFileSync(join(folder, name), 'utf8');
      expect(text.match(/ask-plan-|\bplanner\b/g), name).toBeNull();
    }
  });
});
