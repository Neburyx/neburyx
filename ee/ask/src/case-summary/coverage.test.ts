import type { Count, GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { assembleText } from './assemble.js';
import { citationsOf, retrievalLine, summaryLine } from './coverage.js';

const ref = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
const node = (stableId: string): GraphNode => ({ ref: ref(stableId), display: { title: stableId, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const edge = (id: string): GraphEdge => ({ ref: { sourceId: 'demo', type: 'USES', from: 'widget', to: 'widget', stableId: id }, from: ref('A-1'), to: ref('A-2'), type: 'USES', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
const reading = (extra: Partial<SummaryReading> = {}): SummaryReading => ({ nodes: [node('A-1'), node('A-2')], edges: [edge('L-1')], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0, ...extra });

describe('the retrieval line, in the words of the export header', () => {
  it.each<[Count, number, string]>([
    [{ value: 148, quality: 'lowerBound', scope: 'coverage' }, 25, '2 shown · ≥ 148 not yet retrieved (lower bound · 25 entities not yet counted)'],
    [{ value: 38, quality: 'estimated', scope: 'coverage' }, 0, '2 shown · ~38 not yet retrieved (estimated)'],
    [{ value: 5, quality: 'exact', scope: 'coverage' }, 0, '2 shown · 5 not yet retrieved (exact)'],
    [{ quality: 'unknown', scope: 'coverage' }, 3, '2 shown · more not yet retrieved (3 entities not yet counted)'],
  ])('writes the count %j with its label and the entities not yet counted', (count, uncounted, line) => {
    expect(retrievalLine(reading({ notRetrieved: count, uncounted }))).toBe(line);
  });

  it('says how many references could not be read, and that access may hide items', () => {
    expect(retrievalLine(reading({ unresolved: 2, omitted: true }))).toBe('2 shown · 0 not yet retrieved (exact) · 2 references could not be read · Some items may be hidden by your access.');
  });
});

describe('the summary line and the citations', () => {
  const assembled = assembleText(reading());
  const kept = [
    { text: 'A.', cites: ['n2', 'e1'] },
    { text: 'B.', cites: ['e1', 'n1'] },
  ];

  it('counts the elements the kept sentences cite out of those shown', () => {
    expect(summaryLine(kept, reading())).toBe('The draft cites 3 of the 3 shown elements.');
    expect(summaryLine([{ text: 'A.', cites: ['n1'] }], reading())).toBe('The draft cites 1 of the 3 shown elements.');
  });

  it('says so when no sentence was kept', () => {
    expect(summaryLine([], reading())).toBe('No sentence was kept.');
  });

  it('lists each cited key once with its kind and reference, in the order of first use, and none when nothing is kept', () => {
    expect(citationsOf(kept, assembled).map((entry) => [entry.key, entry.kind])).toEqual([['n2', 'entity'], ['e1', 'relationship'], ['n1', 'entity']]);
    expect(citationsOf([], assembled)).toEqual([]);
  });
});
