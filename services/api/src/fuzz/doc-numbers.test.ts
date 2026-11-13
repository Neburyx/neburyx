import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, RECORDED_RUNS, RUN_SEED, SEED_OF_RECORD, enumeratedCount, shapeCount } from '../testing/pattern-shapes.js';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'fuzz-suite.md'), 'utf8');
const written = (value: bigint | number): string => value.toLocaleString('en-US');

/** What a document says that the code decides: the row of each step count, the enumerated number, the seeds and the random draws. */
function disagreements(text: string): string[] {
  const out: string[] = [];
  for (const steps of [1, 2, 3, 4]) if (!text.includes(`| ${steps} | ${written(shapeCount({ ...CAPS, steps }))} |`)) out.push(`the row of ${steps} steps`);
  if (!text.includes(`**${written(enumeratedCount())}** shapes`)) out.push('the enumerated number');
  if (!text.includes(`${RECORDED_RUNS} more at random from seed ${RUN_SEED}`)) out.push('the random draws and their seed');
  if (!text.includes(`600 shapes drawn at random from seed ${SEED_OF_RECORD}`)) out.push('the corpus draws and their seed');
  return out;
}

describe('the numbers in docs/fuzz-suite.md', () => {
  it('are the numbers the code gives: the shapes under the caps for each step count, the shapes enumerated, the random draws and the seeds', () => {
    expect(disagreements(doc)).toEqual([]);
  });

  it('are found wrong when a number is swapped, a row is changed or a seed is not the one of the code', () => {
    expect(disagreements(doc.replace(written(enumeratedCount()), '1,358'))).toEqual(['the enumerated number']);
    expect(disagreements(doc.replace(`| 2 | ${written(shapeCount({ ...CAPS, steps: 2 }))} |`, `| 2 | ${written(shapeCount({ ...CAPS, steps: 3 }))} |`))).toEqual(['the row of 2 steps']);
    expect(disagreements(doc.replace(`seed ${RUN_SEED}`, 'seed 1'))).toEqual(['the random draws and their seed']);
  });
});
