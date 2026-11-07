import { searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { evidenceCalls, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'REC-1';
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }];
const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', batchRef: TEXT } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: TEXT } };
const carrying = (count: number): StoredRelationship[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `5:r:${index + 1}`, type: 'MADE_FROM', from: widgetNode, to: gadgetNode, properties: { linkId: `L-${String(index + 1).padStart(3, '0')}`, recordId: TEXT } }));

async function searched(relationships: readonly StoredRelationship[], mappingOverrides: Record<string, unknown> = {}, respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>) {
  const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS, ...mappingOverrides });
  const parts = await startSearchApp({ mapping, respond: respond ?? searchModelOf([widgetNode, gadgetNode], () => undefined, relationships) });
  const answer: SearchResult = searchResultSchema.parse((await postSearch(parts.app, { sourceId: 'demo', text: TEXT })).json());
  await parts.app.close();
  return { answer, executor: parts.executor };
}

describe('the count of the evidence group', () => {
  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i supporting relationships as %i hits and an %s count with its scope', async (relationships, hits, quality) => {
    const { answer, executor } = await searched(carrying(relationships));
    expect(answer.evidence.hits).toHaveLength(hits);
    expect(new Set(answer.evidence.hits.map((hit) => hit.supports.stableId)).size).toBe(hits);
    expect(answer.evidence.count).toEqual({ value: hits, quality, scope: 'search:evidence' });
    expect(answer.cap).toBe(25);
    expect(evidenceCalls(executor)[0]?.rowLimit).toBe(26);
  });

  it.each([
    [9, 9, 'exact'],
    [10, 10, 'exact'],
    [11, 10, 'lowerBound'],
  ])('shows %i supporting relationships as %i hits and an %s count for a source whose max_page is 10, and sends no limit above it', async (relationships, hits, quality) => {
    const { answer, executor } = await searched(carrying(relationships), { budgets: { max_page: 10, default_page: 10 } });
    expect(answer.evidence.hits).toHaveLength(hits);
    expect(answer.evidence.count).toEqual({ value: hits, quality, scope: 'search:evidence' });
    expect(answer.cap).toBe(10);
    expect(evidenceCalls(executor)[0]?.rowLimit).toBe(11);
  });

  it('holds the number of hits it has, as a lower bound, when the read overflowed and normalization left rows out, never a number above what is shown', async () => {
    const idless: StoredNode = { elementId: '4:s:9', label: 'Gadget', properties: {} };
    const rows = [...carrying(23), ...carrying(30).slice(23, 26).map((link) => ({ ...link, elementId: `5:x:${link.elementId}`, to: idless }))];
    const { answer } = await searched(rows);
    expect(answer.evidence.hits.length).toBeLessThan(25);
    expect(answer.evidence.count).toEqual({ value: answer.evidence.hits.length, quality: 'lowerBound', scope: 'search:evidence' });
  });

  it('gives a group whose read failed the quality unknown and no number', async () => {
    const model = searchModelOf([widgetNode, gadgetNode], () => undefined, carrying(3));
    const { answer } = await searched([], {}, (call) => (call.templateId === 'relationship-evidence' ? Promise.resolve({ status: 'timeout' }) : model(call)));
    expect(answer.evidence.count).toEqual({ quality: 'unknown', scope: 'search:evidence' });
    expect(answer.evidence.count).not.toHaveProperty('value');
    expect(answer.evidence.hits).toEqual([]);
  });

  it('keeps the exact, related and evidence counts apart, each in its own scope', async () => {
    const stored: StoredNode[] = [widgetNode, { elementId: '4:s:3', label: 'Widget', properties: { widgetId: TEXT } }, gadgetNode];
    const { answer } = await searched([], {}, searchModelOf(stored, () => undefined, carrying(2)));
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.count).toEqual({ value: 2, quality: 'exact', scope: 'search:related' });
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
  });
});
