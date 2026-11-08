import type { GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { checkSameSequence, checkWalk, type WalkedPage } from './walk.js';

/** A row with only the fields the walk check reads. */
const edge = (id: number, observedLast?: string, members?: number): GraphEdge =>
  ({ ref: { sourceId: 's', type: 'T', from: 'a', to: 'b', stableId: String(id) }, type: 'T', ...(observedLast === undefined ? {} : { observedLast }), ...(members === undefined ? {} : { memberCount: { value: members, quality: 'exact', scope: 'x' } }) }) as unknown as GraphEdge;

const pages = (...lists: GraphEdge[][]): WalkedPage[] => lists.map((edges, index) => ({ edges, hasMore: index < lists.length - 1 }));

describe('the check of a walk', () => {
  it('accepts a whole order read once, with the dated rows first', () => {
    const walk = pages([edge(1, '2026-02'), edge(2, '2026-01')], [edge(3), edge(4)]);
    expect(checkWalk(walk, { rows: 4, relationships: 4 }, 'a walk')).toHaveLength(4);
  });

  it('counts the members of an aggregate', () => {
    expect(() => checkWalk(pages([edge(1, '2026-02', 10)]), { rows: 1, relationships: 10 }, 'a walk')).not.toThrow();
    expect(() => checkWalk(pages([edge(1, '2026-02', 10)]), { rows: 1, relationships: 1 }, 'a walk')).toThrow('stand for 10 relationships, 1 expected');
  });

  it.each([
    ['a repeated row', pages([edge(1, '2026-02'), edge(1, '2026-02')]), 'returned twice'],
    ['a repeated page', pages([edge(1, '2026-02')], [edge(1, '2026-02')]), 'returned twice'],
    ['a missed row', pages([edge(1, '2026-02')]), '1 rows walked, 2 expected'],
    ['a shuffled page: a dated row after an undated one', pages([edge(1), edge(2, '2026-02')]), 'comes after a row with none'],
    ['a last page that has more', [{ edges: [edge(1, '2026-02'), edge(2, '2026-01')], hasMore: true }], 'has more'],
    ['a short page before the last', [{ edges: [edge(1, '2026-02')], hasMore: false }, { edges: [edge(2, '2026-01')], hasMore: false }], 'ends the order'],
  ])('fails %s, naming the row or the page', (_name, walk, message) => {
    expect(() => checkWalk(walk, { rows: 2, relationships: 2 }, 'a walk')).toThrow(message);
  });

  it('fails two walks that differ, naming the first row that does', () => {
    expect(() => checkSameSequence(['a', 'b', 'c'], ['a', 'c', 'b'], 'two sizes')).toThrow('differ at row 2');
    expect(() => checkSameSequence(['a'], ['a', 'b'], 'two sizes')).toThrow('1 rows against 2');
    expect(() => checkSameSequence(['a', 'b'], ['a', 'b'], 'two sizes')).not.toThrow();
  });
});
