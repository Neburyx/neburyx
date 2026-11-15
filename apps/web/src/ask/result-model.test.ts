import type { AskRunResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { addableOf, resultView } from './result-model.js';

const count = (quality: string, value?: number) => (value === undefined ? { quality, scope: 't' } : { quality, value, scope: 't' });
const node = (id: string) => ({ ref: { sourceId: 'demo', entityType: 'widget', stableId: id }, display: { title: `W ${id}`, type: 'widget' } });
const edge = (id: string) => ({ ref: { id }, type: 'LINK', from: node('a').ref, to: node('b').ref });
const run = (templateId: string, result: unknown): AskRunResult => ({ templateId, result }) as AskRunResult;

describe('what a result adds to the graph', () => {
  it.each([
    ['shared-attribute', run('shared-attribute', { status: 'ok', nodes: [node('a'), node('b')], edges: [edge('e')], count: count('exact', 1), notices: [] }), ['a', 'b'], 1],
    ['linked-entities', run('linked-entities', { status: 'ok', nodes: [node('a')], edges: [], count: count('exact', 1), notices: [] }), ['a'], 0],
    ['entity', run('entity', node('a')), ['a'], 0],
    ['expand', run('expand', { nodes: [node('a'), node('b')], edges: [edge('e'), edge('f')], pages: [] }), ['a', 'b'], 2],
    ['derived-rule-run', run('derived-rule-run', { results: [{ nodes: [node('a')], edges: [edge('e')], count: count('exact', 1), ruleId: 'r' }, { nodes: [node('b')], edges: [], count: count('exact', 0), ruleId: 's' }] }), ['a', 'b'], 1],
    ['search', run('search', { exact: [node('a')], counts: { exact: count('exact', 1) }, related: { count: count('exact', 0) }, evidence: { count: count('exact', 0) } }), ['a'], 0],
  ])('are the nodes and edges that %s lists', (_name, result, ids, edges) => {
    const addable = addableOf(result);
    expect(addable?.nodes.map((entry) => entry.ref.stableId)).toEqual(ids);
    expect(addable?.edges).toHaveLength(edges);
    expect(addable?.templateId).toBe(result.templateId);
  });

  it('are nothing for a result with no node to draw, and nothing for the stop of a heavy run', () => {
    expect(addableOf(run('degree-preview', { total: count('exact', 1), byType: [] }))).toBeUndefined();
    expect(addableOf(run('derived-edge-support', { supports: { count: count('exact', 1) } }))).toBeUndefined();
    expect(addableOf(run('shared-attribute', { status: 'heavy', estimate: count('lowerBound', 5), threshold: 5, notices: [] }))).toBeUndefined();
  });
});

describe('a path result', () => {
  it('offers the entities and relationships of the paths to add, and nothing for the heavy stop', () => {
    expect(addableOf(run('shortest-paths', { status: 'ok', paths: [], nodes: [node('a'), node('b')], edges: [] }))?.nodes).toHaveLength(2);
    expect(addableOf(run('shortest-paths', { status: 'heavy', estimate: count('lowerBound', 500), threshold: 500, continueLimit: 25, warnings: [] }))).toBeUndefined();
  });

  it('says how many paths were found, and gives the heavy stop its lower bound', () => {
    expect(resultView(run('shortest-paths', { status: 'ok', paths: [{ hops: 1, steps: [] }, { hops: 1, steps: [] }], nodes: [], edges: [] })).lines).toEqual([{ label: 'Paths', text: '2 found' }]);
    expect(resultView(run('shortest-paths', { status: 'heavy', estimate: count('lowerBound', 500), threshold: 500, continueLimit: 25, warnings: [] })).count).toEqual({ count: count('lowerBound', 500), noun: 'match' });
  });
});

describe('a result in words', () => {
  it.each([['exact'], ['estimated'], ['lowerBound']])('gives a count that is %s with its quality, to be drawn as a figure', (quality) => {
    expect(resultView(run('shared-attribute', { status: 'ok', nodes: [], edges: [], count: count(quality, 1), notices: [] })).count).toEqual({ count: count(quality, 1), noun: 'match' });
  });

  it('gives a count that is unknown with no number', () => {
    expect(resultView(run('derived-edge-support', { supports: { count: count('unknown') } })).lines).toEqual([{ label: 'Supports', text: 'no count' }]);
  });

  it('gives the pages of an expansion with what each shows, its total with its label, and that more exists', () => {
    const view = resultView(run('expand', { nodes: [], edges: [], pages: [{ neighborType: 'gadget', returned: 3, hasMore: true, matchingTotal: count('lowerBound', 3) }, { neighborType: 'part', returned: 1, hasMore: false, matchingTotal: count('exact', 1) }] }));
    expect(view.lines).toEqual([{ label: 'gadget', text: '3 shown · ≥ 3 · lower bound · more on the next page' }, { label: 'part', text: '1 shown · 1 · exact' }]);
  });

  it('gives the three counts of a search and the counts of each rule', () => {
    expect(resultView(run('search', { exact: [], counts: { exact: count('exact', 2) }, related: { count: count('lowerBound', 5) }, evidence: { count: count('unknown') } })).lines.map((line) => line.text)).toEqual(['2 · exact', '≥ 5 · lower bound', 'no count']);
    expect(resultView(run('derived-rule-run', { results: [{ ruleId: 'r', nodes: [], edges: [], count: count('exact', 0) }] })).lines).toEqual([{ label: 'r', text: '0 · exact' }]);
  });

  it('gives the degree of an entity by relationship type and direction', () => {
    const view = resultView(run('degree-preview', { total: count('exact', 3), byType: [{ relationshipType: 'HOLDS', direction: 'out', count: count('exact', 2) }, { relationshipType: 'OWNS', direction: 'in', count: count('lowerBound', 1) }] }));
    expect(view.lines.map((line) => `${line.label}: ${line.text}`)).toEqual(['Relationships: 3 · exact', 'HOLDS · outgoing: 2 · exact', 'OWNS · incoming: ≥ 1 · lower bound']);
  });

  it('gives the notices of a template run in the words of the patterns results, and none for the others', () => {
    expect(resultView(run('shared-attribute', { status: 'ok', nodes: [], edges: [], count: count('lowerBound', 1), notices: [{ code: 'readBounded' }, { code: 'noStopList' }] })).notices).toEqual(['The read was cut, so the count is a lower bound.', 'The source has no stop list for this pattern.']);
    expect(resultView(run('entity', node('a'))).notices).toEqual([]);
  });
});

describe('the result of a file query', () => {
  const result = run('file-query', { status: 'ok', intent: 'byName', nodes: [node('a'), node('b')], edges: [edge('e')], count: count('lowerBound', 50), notices: [{ code: 'readBounded' }], warnings: [] });

  it('adds its nodes and edges to the graph', () => {
    expect(addableOf(result)).toMatchObject({ nodes: [{ ref: { stableId: 'a' } }, { ref: { stableId: 'b' } }], edges: [{ ref: { id: 'e' } }], templateId: 'file-query' });
  });

  it('shows the rows it returned with their quality label, and the notices in the same words as a template run', () => {
    const view = resultView(result);
    expect(view.count).toEqual({ count: count('lowerBound', 50), noun: 'row' });
    expect(view.rows).toEqual(['W a → LINK → W b']);
    expect(view.notices.length).toBe(1);
  });
});
