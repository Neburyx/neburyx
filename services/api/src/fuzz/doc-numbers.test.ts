import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECORDED_RUNS, SEED_OF_RECORD, enumeratedCount, shapeCount } from '../testing/pattern-shapes.js';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'fuzz-suite.md'), 'utf8');
const written = (value: bigint | number): string => value.toLocaleString('en-US');

describe('the numbers in docs/fuzz-suite.md', () => {
  it('are the numbers the code gives: the shapes under the caps for one to four steps, the shapes enumerated, the seed and the random draws', () => {
    for (const steps of [1, 2, 3, 4]) expect(doc, `${steps} steps`).toContain(written(shapeCount({ steps, perTarget: 6, perPattern: 24 })));
    expect(doc).toContain(written(enumeratedCount()));
    expect(doc).toContain(String(SEED_OF_RECORD));
    expect(doc).toContain(`${RECORDED_RUNS} more at random`);
  });

  it('fail when a number in the document is not the one the code gives', () => {
    expect(doc.replace(written(enumeratedCount()), '1,358')).not.toContain(written(enumeratedCount()));
  });
});
