import type { AskRunResult, GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { summaryOfRun } from './attach.js';

const node = (stableId: string, title: string): GraphNode => ({ ref: { sourceId: 'demo', entityType: 'node_a', stableId }, display: { title, type: 'node_a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const result = { templateId: 'saved-pattern', result: { status: 'ok', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 's' }, matches: [{ match: node('b-1', 'Bob').ref, hops: 1, through: [], relationships: [{ relationshipType: 'LINKS', from: node('a-1', 'Alice').ref, to: null }] }], nodes: [node('a-1', 'Alice'), node('b-1', 'Bob')], edges: [], notices: [], warnings: [] } } as unknown as AskRunResult;
const params = { patternId: '0192f000-0000-7000-8000-0000000000b1', patternVersion: 1, ref: { entityType: 'node_a', stableId: 'a-1' } };
const warnings: Record<string, unknown>[] = [];
const logger = { warn: (fields: Record<string, unknown>) => void warnings.push(fields) };

describe('the summary of a saved-pattern run answer, with the real builders', () => {
  it('is attached, naming the start of the run', () => {
    const summary = summaryOfRun(result, { sourceId: 'demo', params }, logger);
    expect(summary?.sentences[0]?.text).toBe('Bob matches the saved pattern from Alice.');
    expect(warnings).toEqual([]);
  });

  it('is dropped with the code other-source when the run is of another source, and the run answer is unchanged', () => {
    warnings.length = 0;
    expect(summaryOfRun(result, { sourceId: 'other', params }, logger)).toBeUndefined();
    expect(warnings).toEqual([{ event: 'ask-summary-dropped', code: 'other-source' }]);
  });

  it('is dropped with the code builder-threw when the result is not one the builder can read', () => {
    warnings.length = 0;
    const broken = { templateId: 'saved-pattern', result: { status: 'ok', matches: [null], nodes: [], edges: [], notices: [], count: { quality: 'exact', value: 1, scope: 's' } } } as unknown as AskRunResult;
    expect(summaryOfRun(broken, { sourceId: 'demo', params }, logger)).toBeUndefined();
    expect(warnings).toEqual([{ event: 'ask-summary-dropped', code: 'builder-threw' }]);
  });
});
