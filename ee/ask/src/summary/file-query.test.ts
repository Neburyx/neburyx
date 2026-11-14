import { askSummarySchema, type FileQueryResult, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { summaryOfFileQuery } from './attach.js';
import { citedKeysExist } from './core.js';
import { fileQueryListed, summarizeFileQuery, summarizeFileQueryResult } from './file-query.js';

const ref = (stableId: string, sourceId = 'demo') => ({ sourceId, entityType: 'node_a', stableId });
const node = (stableId: string, title = stableId, sourceId = 'demo'): GraphNode => ({
  ref: ref(stableId, sourceId),
  display: { title, type: 'node_a' },
  properties: [{ key: 'private', value: 'PROPERTY-MARKER', dataClass: 'text', masked: false }],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const edge = (from: string, to: string, type = 'KNOWS'): GraphEdge => ({ ref: { sourceId: 'demo', type, from: 'node_a', to: 'node_a', stableId: `${from}-${to}` }, from: ref(from), to: ref(to), type, direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
const count = (quality: 'exact' | 'lowerBound' | 'estimated' | 'unknown', value?: number) => (value === undefined ? { quality, scope: 'rows' } : { quality, value, scope: 'rows' });
const result = (over: Partial<FileQueryResult> = {}): FileQueryResult => ({ status: 'ok', intent: 'who-knows', count: count('exact', 2), nodes: [node('a', 'Alice'), node('b', 'Bob')], edges: [edge('a', 'b')], notices: [], warnings: ['WARNING-MARKER'], ...over });
const words = (value: FileQueryResult): string => (summarizeFileQuery(value)?.sentences ?? []).map((sentence) => sentence.text).join(' ');

describe('the summary of a file-query result', () => {
  it('gives the count of rows with its label, the names, the relationships and types, and the number shown, each sentence citing listed elements', () => {
    const value = result();
    const summary = summarizeFileQuery(value);
    expect(summary).toBeDefined();
    if (summary === undefined) return;
    expect(askSummarySchema.safeParse(summary).success).toBe(true);
    expect(citedKeysExist(summary, fileQueryListed(value))).toBe(true);
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Rows returned by the query: 2 · exact.', 'They are Alice and Bob.', '1 relationship is shown, of 1 type.']);
    expect(summary.omissions).toBe('2 shown.');
  });

  it('names at most five nodes and counts the types of the relationships', () => {
    const many = Array.from({ length: 7 }, (_unused, index) => node(`n${index}`, `Name ${index}`));
    const text = words(result({ nodes: many, edges: [edge('n0', 'n1'), edge('n1', 'n2', 'PAID')], count: count('exact', 7) }));
    expect(text).toContain('Name 4');
    expect(text).not.toContain('Name 5');
    expect(text).toContain('2 relationships are shown, of 2 types.');
  });

  it('says that more may exist for a cut result, and a count is never exact then', () => {
    const summary = summarizeFileQuery(result({ count: count('lowerBound', 50), notices: [{ code: 'readBounded' }] }));
    expect(summary?.omissions).toBe('50 shown; more may exist (lower bound).');
    const text = (summary?.sentences ?? []).map((sentence) => sentence.text).join(' ');
    expect(text).toContain('≥ 50 · lower bound');
    expect(text).toContain('The read was cut, so the count is a lower bound.');
    expect(text).not.toContain('50 · exact');
  });

  it('has no summary for a result that lists no node, because a sentence must cite an element', () => {
    expect(summarizeFileQuery(result({ nodes: [], edges: [], count: count('exact', 0) }))).toBeUndefined();
    expect(summarizeFileQueryResult(result({ nodes: [], edges: [], count: count('exact', 0) }))).toEqual({ kind: 'none' });
  });

  it('holds no property value, no warning text and nothing of the result but node titles, counts and fixed notice sentences', () => {
    const text = JSON.stringify(summarizeFileQuery(result({ notices: [{ code: 'readBounded' }] })));
    for (const marker of ['PROPERTY-MARKER', 'WARNING-MARKER']) expect(text).not.toContain(marker);
  });

  it('is dropped whole, with a fixed code and no value, when a citation is of another source or the builder cannot read the result', () => {
    const warnings: Record<string, unknown>[] = [];
    const logger = { warn: (fields: Record<string, unknown>) => void warnings.push(fields) };
    expect(summaryOfFileQuery(result(), 'demo', logger)?.sentences.length).toBeGreaterThan(0);
    expect(summaryOfFileQuery(result(), 'other', logger)).toBeUndefined();
    expect(summaryOfFileQuery({ nodes: [null] } as never, 'demo', logger)).toBeUndefined();
    expect(warnings).toEqual([{ event: 'ask-summary-dropped', code: 'other-source' }, { event: 'ask-summary-dropped', code: 'builder-threw' }]);
  });
});
