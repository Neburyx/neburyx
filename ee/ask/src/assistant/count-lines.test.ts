import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askRunResultSchema, type AskRunResult, type SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { viewCoverageOf } from '../case-summary/coverage.js';
import { assembleText } from '../case-summary/assemble.js';
import { degreeCountsOf } from './coverage.js';
import { assembleResults } from './tool-answer.js';

/** Two entity types and their display names, read from a shipped mapping. No name of a pack is written here. */
function namesOf(pack: string): { readonly types: readonly [string, string]; readonly names: ReadonlyMap<string, string> } {
  const mapping = readFileSync(fileURLToPath(new URL(`../../../../domain-packs/${pack}/neburyx.yaml`, import.meta.url)), 'utf8');
  const [entities = ''] = mapping.split(/^ +relationships:$/mu);
  const found = entities.split(/^ +- type: /mu).slice(1).map((block) => [block.split('\n')[0] ?? '', /^ +label: (\S+)/mu.exec(block)?.[1] ?? ''] as const);
  const [first, second] = found;
  if (first === undefined || second === undefined) throw new Error(`the ${pack} pack has fewer than two entity types`);
  return { types: [first[0], second[0]], names: new Map([first, second]) };
}

const PACKS = ['banking-fraud', 'insurance-claims'].map((pack) => ({ pack, ...namesOf(pack) }));
const count = (value: number, quality = 'exact') => ({ quality, value, scope: 'test' });

describe.each(PACKS)('the counts the server writes for the model, with the names of $pack', ({ types: [one, other], names }) => {
  const [first, second] = [names.get(one) ?? one, names.get(other) ?? other];
  const node = (entityType: string, stableId: string) => ({ ref: { sourceId: 'demo', entityType, stableId }, display: { title: `Item ${stableId}`, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
  const reading = (over: Partial<SummaryReading> = {}): SummaryReading => ({ nodes: [node(one, 'A'), node(other, 'B'), node(other, 'C')], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 109, quality: 'lowerBound', scope: 'coverage' }, uncounted: 0, ...over });
  const degree = (total: number, quality = 'exact'): AskRunResult =>
    askRunResultSchema.parse({
      templateId: 'degree-preview',
      result: { ref: node(one, 'A').ref, total: count(total, quality), byType: [], byNeighborType: total === 0 ? [] : [{ entityType: other, count: count(total - 1) }, { entityType: one, count: count(1, quality) }], warnings: [], pageSize: 25, heavyOpThreshold: 1000 },
    });

  it('labels every count of the line of the view', () => {
    expect(viewCoverageOf(reading(), names).text).toBe(`3 entities shown (exact), by type: ${[`1 ${first} (exact)`, `2 ${second} (exact)`].sort().join(', ')} · 0 relationships shown (exact) · ≥ 109 not yet retrieved (lower bound)`);
    expect(viewCoverageOf(reading({ unresolved: 2 }), names).text).toContain(' · 2 references could not be read (exact)');
    expect(viewCoverageOf(reading({ nodes: [] }), names).text).toMatch(/^0 entities shown \(exact\) · /);
  });

  it('keeps what a sentence must copy of a count that is not exact', () => {
    expect(viewCoverageOf(reading(), names).inexact).toEqual({ phrase: '≥ 109', value: '109' });
    expect(viewCoverageOf(reading({ notRetrieved: { quality: 'unknown', scope: 'coverage' } }), names).inexact).toBe('unknown');
  });

  it('states a degree read as counts of relationship ends, each with its quality', () => {
    expect(degreeCountsOf(degree(10), names)).toBe(`relationship ends by the type at the other end: ${second} 9 (exact) · ${first} 1 (exact) · all relationship ends 10 (exact)`);
    expect(degreeCountsOf(degree(1000, 'lowerBound'), names)).toContain('all relationship ends ≥ 1,000 · lower bound');
  });

  it('adds no phrase of absence to the line of a degree read, which states its count', () => {
    const line = assembleResults([{ tool: 'degree-preview', result: degree(10) }], undefined, names).assembled.lines.get('s1') ?? '';
    expect(line).toContain('all relationship ends 10 (exact)');
    expect(line).not.toContain('no relationship listed');
    expect(line).not.toContain('connected elements');
  });

  it('writes the view line over the assembled text of the view as the answer paths do', () => {
    const view = assembleText(reading());
    const lines = assembleResults([], view, names, viewCoverageOf(reading(), names)).assembled.lines;
    expect(lines.get('c1')).toContain('3 entities shown (exact)');
  });
});
