import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askRunResultSchema, type AskRunResult } from '@neburyx/contracts';
import { judgeSentences } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';
import { checkedTextOf } from '../case-summary/judge.js';
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

describe.each(PACKS)('a claim of no relationship over a degree read, with the names of $pack', ({ types: [one, other], names }) => {
  const node = (entityType: string, stableId: string) => ({ ref: { sourceId: 'demo', entityType, stableId }, display: { title: `Item ${stableId}`, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
  const degree = (total: number, quality = 'exact'): AskRunResult =>
    askRunResultSchema.parse({
      templateId: 'degree-preview',
      result: { ref: node(one, 'A').ref, total: count(total, quality), byType: [], byNeighborType: total === 0 ? [] : [{ entityType: other, count: count(total - 1) }, { entityType: one, count: count(1, quality) }], warnings: [], pageSize: 25, heavyOpThreshold: 1000 },
    });

  const kept = (result: AskRunResult, sentence: string): boolean => {
    const { assembled, readKeys } = assembleResults([{ tool: 'degree-preview', result }], undefined, names);
    const checked = checkedTextOf(assembled);
    // the keys of the reads are citable lines, as the answer paths hand them to the check
    const text = { ...checked, keys: new Map([...checked.keys, ...readKeys.map((key) => [key, true] as const)]), readKeys: new Set(readKeys) };
    return judgeSentences([{ text: sentence, cites: ['s1'] }], text).kept.length === 1;
  };

  it('removes a sentence that says no relationship was retrieved when the read counts some, and keeps the count', () => {
    expect(kept(degree(10), 'The read lists no relationship, so a separate relationship count is not retrieved.')).toBe(false);
    expect(kept(degree(10), 'The item has no relationships.')).toBe(false);
    expect(kept(degree(10), 'The item has 10 relationship ends (exact).')).toBe(true);
  });

  it('keeps a sentence of no relationship when the read counts none, and one of a count that is a lower bound only with its phrase', () => {
    expect(kept(degree(0), 'The item has no relationships.')).toBe(true);
    expect(kept(degree(1000, 'lowerBound'), 'The item has no relationships.')).toBe(false);
  });
});
