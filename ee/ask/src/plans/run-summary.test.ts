import type { AskRunResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { summarizeRun } from './run-summary.js';

const count = (quality: string, value = 1) => ({ quality, value, scope: 'test' });
const node = { ref: { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' } };
const run = (templateId: string, result: unknown): AskRunResult => ({ templateId, result }) as AskRunResult;
const shared = (over: object) => run('shared-attribute', { status: 'ok', count: count('exact'), nodes: [node, node, node], notices: [], ...over });

describe('the row count and the cut of a template run', () => {
  it('counts the nodes the result lists, and is not partial when nothing says it was cut', () => {
    expect(summarizeRun(shared({}))).toEqual({ rowCount: 3, partial: false });
    expect(summarizeRun(run('linked-entities', { status: 'ok', count: count('exact'), nodes: [], notices: [] }))).toEqual({ rowCount: 0, partial: false });
  });

  it.each([
    ['a lower-bound count', { count: count('lowerBound') }],
    ['a readBounded notice', { notices: [{ code: 'readBounded' }] }],
  ])('is partial for %s', (_name, over) => {
    expect(summarizeRun(shared(over))).toEqual({ rowCount: 3, partial: true });
  });

  it('is not partial for the other notices or an estimated count', () => {
    expect(summarizeRun(shared({ count: count('estimated'), notices: [{ code: 'noStopList' }, { code: 'undatedExcluded' }] })).partial).toBe(false);
  });

  it('lists nothing and is partial for a run that stopped as heavy', () => {
    expect(summarizeRun(run('shared-attribute', { status: 'heavy', estimate: count('lowerBound', 1000) }))).toEqual({ rowCount: 0, partial: true });
  });
});

describe('the row count and the cut of the other templates', () => {
  it('counts one entity and never calls it partial', () => {
    expect(summarizeRun(run('entity', node))).toEqual({ rowCount: 1, partial: false });
  });

  it('counts the degree entries, and is partial when a count is a lower bound', () => {
    const byType = [{ count: count('exact') }, { count: count('exact') }];
    expect(summarizeRun(run('degree-preview', { total: count('exact'), byType }))).toEqual({ rowCount: 2, partial: false });
    expect(summarizeRun(run('degree-preview', { total: count('lowerBound'), byType }))).toEqual({ rowCount: 2, partial: true });
    expect(summarizeRun(run('degree-preview', { total: count('exact'), byType: [{ count: count('lowerBound') }] }))).toEqual({ rowCount: 1, partial: true });
  });

  it('counts the nodes of an expansion, and is partial when a page has more, a cursor or a lower-bound total', () => {
    const page = { hasMore: false, matchingTotal: count('exact') };
    expect(summarizeRun(run('expand', { nodes: [node], pages: [page] }))).toEqual({ rowCount: 1, partial: false });
    expect(summarizeRun(run('expand', { nodes: [node], pages: [{ ...page, hasMore: true }] })).partial).toBe(true);
    expect(summarizeRun(run('expand', { nodes: [node], pages: [{ ...page, nextCursor: 'c' }] })).partial).toBe(true);
    expect(summarizeRun(run('expand', { nodes: [node], pages: [{ ...page, matchingTotal: count('lowerBound') }] })).partial).toBe(true);
  });

  it('counts the nodes of the rule’s results, none for a rule with no result, and is partial for a lower-bound count', () => {
    expect(summarizeRun(run('derived-rule-run', { results: [{ nodes: [node, node], count: count('exact') }] }))).toEqual({ rowCount: 2, partial: false });
    expect(summarizeRun(run('derived-rule-run', { results: [{ nodes: [], count: count('exact', 0) }] }))).toEqual({ rowCount: 0, partial: false });
    expect(summarizeRun(run('derived-rule-run', { results: [{ nodes: [node], count: count('lowerBound') }] })).partial).toBe(true);
  });

  it('counts one derived edge, and is partial when its supports are a lower bound', () => {
    expect(summarizeRun(run('derived-edge-support', { supports: { count: count('exact') } }))).toEqual({ rowCount: 1, partial: false });
    expect(summarizeRun(run('derived-edge-support', { supports: { count: count('lowerBound') } }))).toEqual({ rowCount: 1, partial: true });
  });

  it('counts the hits of every group of a search, and is partial for a next page or a lower bound in any of them', () => {
    const search = (over: object) => run('search', { exact: [node], related: { hits: [{}, {}], count: count('exact') }, evidence: { hits: [{}], count: count('exact') }, counts: { exact: count('exact') }, ...over });
    expect(summarizeRun(search({}))).toEqual({ rowCount: 4, partial: false });
    expect(summarizeRun(search({ exactNextCursor: 'c' })).partial).toBe(true);
    expect(summarizeRun(search({ related: { hits: [], count: count('exact'), nextCursor: 'c' } })).partial).toBe(true);
    expect(summarizeRun(search({ evidence: { hits: [], count: count('lowerBound') } })).partial).toBe(true);
    expect(summarizeRun(search({ counts: { exact: count('lowerBound') } })).partial).toBe(true);
    expect(summarizeRun(search({ related: { hits: [], count: count('unknown') } })).partial).toBe(false);
  });
});
