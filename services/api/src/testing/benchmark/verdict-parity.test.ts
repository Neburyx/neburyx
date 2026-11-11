import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Cell } from './measure.js';
import { verdictOf, type Stopped } from './record.js';

const readSet = z.enum(['dated', 'undated', 'aggregate', 'plain', 'all']);

const fixtures = z.array(
  z.object({
    name: z.string(),
    cells: z.array(z.object({ size: z.number(), readSet: readSet, position: z.string(), samples: z.number(), failures: z.number(), p95: z.number() })),
    stopped: z.array(z.object({ size: z.number(), readSet: readSet, atRow: z.number(), notReached: z.array(z.string()) })),
    expected: z.object({ met: z.boolean(), worstP95: z.number(), overLimit: z.array(z.string()).optional(), lowerBound: z.array(z.string()).optional(), stopped: z.array(z.string()).optional() }),
  }),
);

const FIXTURE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../tools/release-checks/fixtures/benchmark-verdicts.json');

describe('the pass rule of the release checks', () => {
  for (const fixture of fixtures.parse(JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')))) {
    it(`gives the verdict of the fixtures the release checks use: ${fixture.name}`, () => {
      const cells = fixture.cells.map((cell): Cell => ({ ...cell, rows: cell.size, repeated: 0, p50: cell.p95, max: cell.p95 }));
      const stopped = fixture.stopped.map((entry): Stopped => ({ ...entry }));
      const verdict = verdictOf(cells, stopped);
      expect(verdict.met).toBe(fixture.expected.met);
      expect(verdict.worstP95).toBe(fixture.expected.worstP95);
      expect(verdict.overTarget.map((cell) => `${cell.readSet}/${cell.position}`)).toEqual(fixture.expected.overLimit ?? []);
      expect(verdict.lowerBound.map((cell) => `${cell.readSet}/${cell.position}`)).toEqual(fixture.expected.lowerBound ?? []);
      expect(verdict.stopped.map((entry) => entry.readSet)).toEqual(fixture.expected.stopped ?? []);
    });
  }
});
