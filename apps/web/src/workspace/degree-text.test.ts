import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Count } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { degreeCountText } from './degree-text.js';
import { remainderLine } from './scope-text.js';

describe('the text of a lower bound', () => {
  const lowerBound = (value: number): Count => ({ value, quality: 'lowerBound', scope: 'degree:out:LINKED:mapped-relationship-ends' });

  it('reads a count of the cap as "≥ 500 · lower bound"', () => {
    expect(degreeCountText(lowerBound(500))).toBe('≥ 500 · lower bound');
  });

  it('reads the part of a lower bound that is not yet retrieved with its quality', () => {
    expect(remainderLine(25, { count: lowerBound(475), uncounted: 0 })).toBe('25 shown · ≥ 475 not yet retrieved (lower bound)');
  });

  it('shows no number for an unknown count', () => {
    expect(degreeCountText({ quality: 'unknown', scope: 'x' })).toBe('no count');
  });
});

describe('the words of counts, against the table the Ask summary of the server reads too', () => {
  it('writes every case of the shared table as the table says', () => {
    const table = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'packages', 'contracts', 'fixtures', 'count-words.json'), 'utf8')) as { cases: { count: Count; words: string }[] };
    expect(table.cases.length).toBeGreaterThan(5);
    for (const { count, words } of table.cases) expect(degreeCountText(count)).toBe(words);
  });
});
