import type { Count, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { edge, ref } from '../state/test-data.js';
import { memberCountText, relationshipLook, relationshipParts } from './relationship-look.js';

const from = ref('a', 'type-a', 'n1');
const to = ref('a', 'type-a', 'n2');
const stored = (type: string): GraphEdge => ({ ...edge('a', 'e1', 'n1', 'n2'), type });
const derived = (type: string): GraphEdge => ({ ...stored(type), ref: { sourceId: 'a', derived: { ruleId: 'rule-1', from, to } }, semantics: 'derived', derivation: { ruleId: 'rule-1', ruleVersion: 1, supportingEdgeRefs: [] } });
const aggregate = (type: string, memberCount: Count, semantics: GraphEdge['semantics'] = 'stored'): GraphEdge => ({
  ...stored(type),
  ref: { sourceId: 'a', aggregate: { type, from, to } },
  memberCount,
  semantics,
  ...(semantics === 'derived' ? { derivation: { ruleId: 'rule-1', ruleVersion: 1, supportingEdgeRefs: [] } } : {}),
});
const count = (value: number | undefined, quality: Count['quality']): Count => (value === undefined ? { quality, scope: 'x' } : { value, quality, scope: 'x' });

describe('the look of a relationship', () => {
  it('carries its type as the label for a stored relationship that is not an aggregate, with no count badge', () => {
    expect(relationshipLook(stored('USES'))).toEqual({ aggregate: false, origin: 'stored', label: 'USES' });
  });

  it('marks a relationship whose end is selected as touched, and changes nothing else', () => {
    expect(relationshipLook(stored('USES'), true)).toEqual({ aggregate: false, origin: 'stored', label: 'USES', touched: true });
    expect(relationshipLook(stored('USES'), false)).toEqual({ aggregate: false, origin: 'stored', label: 'USES' });
  });

  it('keeps the label of a derived, an unknown-origin and an aggregate relationship whether or not an entity it joins is selected', () => {
    const unknown: GraphEdge = { ...stored('USES'), semantics: 'unknown' };
    for (const edgeOf of [derived('SHARES'), unknown, aggregate('OWNS', count(42, 'exact'))]) expect(relationshipLook(edgeOf, true)).toEqual({ ...relationshipLook(edgeOf, false), touched: true });
  });

  it('labels a derived relationship with its type and "derived"', () => {
    expect(relationshipLook(derived('SHARES'))).toEqual({ aggregate: false, origin: 'derived', label: 'SHARES · derived' });
  });

  it('labels a relationship of unknown origin with its type and "origin unknown", and never as stored', () => {
    const look = relationshipLook({ ...stored('USES'), semantics: 'unknown' });
    expect(look).toEqual({ aggregate: false, origin: 'unknown', label: 'USES · origin unknown' });
  });

  it.each<[string, Count, string, string | undefined]>([
    ['exact', count(42, 'exact'), 'USES · 42 · exact', '42 · exact'],
    ['estimated', count(42, 'estimated'), 'USES · ~ 42 (estimated)', '~ 42 (estimated)'],
    ['lower bound', count(3281, 'lowerBound'), 'USES · ≥ 3,281 · lower bound', '≥ 3,281 · lower bound'],
    ['unknown', count(undefined, 'unknown'), 'USES', undefined],
  ])('labels a stored aggregate with a %s count, and keeps the count as its badge when the count is known', (_name, memberCount, label, badge) => {
    expect(relationshipLook(aggregate('USES', memberCount))).toEqual({ aggregate: true, origin: 'stored', label, ...(badge === undefined ? {} : { badge }) });
  });

  describe('the canvas label of an aggregate of one member', () => {
    it('is the type alone for an exact 1, and keeps the full label for the hover tip', () => {
      expect(relationshipLook(aggregate('SENT', count(1, 'exact')))).toEqual({ aggregate: true, origin: 'stored', label: 'SENT', tip: 'SENT · 1 · exact', single: true });
    });

    it('keeps the origin word for an exact 1 of derived or unknown origin', () => {
      expect(relationshipLook(aggregate('SENT', count(1, 'exact'), 'derived'))).toMatchObject({ label: 'SENT · derived', tip: 'SENT · 1 · exact · derived' });
      expect(relationshipLook(aggregate('SENT', count(1, 'exact'), 'unknown'))).toMatchObject({ label: 'SENT · origin unknown' });
    });

    it.each<[string, Count, string, string]>([
      ['2 exact', count(2, 'exact'), 'SENT · 2 · exact', '2 · exact'],
      ['0 exact', count(0, 'exact'), 'SENT · 0 · exact', '0 · exact'],
      ['1 as a lower bound', count(1, 'lowerBound'), 'SENT · ≥ 1 · lower bound', '≥ 1 · lower bound'],
      ['1 as an estimate', count(1, 'estimated'), 'SENT · ~ 1 (estimated)', '~ 1 (estimated)'],
    ])('keeps the count of %s in the label and as the badge, with no separate tip', (_name, memberCount, label, badge) => {
      expect(relationshipLook(aggregate('SENT', memberCount))).toEqual({ aggregate: true, origin: 'stored', label, badge });
    });

    it('is still an aggregate, and is marked as standing for one relationship, so its line is as thin as a stored one', () => {
      const look = relationshipLook(aggregate('SENT', count(1, 'exact')));
      expect(look.aggregate).toBe(true);
      expect(look.single).toBe(true);
    });

    it.each<[string, Count]>([
      ['exact 2', count(2, 'exact')],
      ['lower bound 1', count(1, 'lowerBound')],
      ['estimated 1', count(1, 'estimated')],
      ['unknown', count(undefined, 'unknown')],
    ])('leaves an aggregate of %s without the mark, so its line keeps the aggregate width', (_name, memberCount) => {
      expect(relationshipLook(aggregate('SENT', memberCount)).single).toBeUndefined();
    });

    it('leaves the parts the menu header and the walk read with the full count', () => {
      expect(relationshipParts(aggregate('SENT', count(1, 'exact')))).toMatchObject({ type: 'SENT', count: '1 · exact' });
    });
  });

  it('adds the origin after the count for an aggregate of derived or unknown origin, keeping the count\'s quality words', () => {
    expect(relationshipLook(aggregate('USES', count(42, 'exact'), 'derived')).label).toBe('USES · 42 · exact · derived');
    expect(relationshipLook(aggregate('USES', count(42, 'estimated'), 'unknown')).label).toBe('USES · ~ 42 (estimated) · origin unknown');
    expect(relationshipLook(aggregate('USES', count(undefined, 'unknown'), 'unknown')).label).toBe('USES · origin unknown');
  });

  it('prints no number for a count that has a quality but no value', () => {
    expect(memberCountText(count(undefined, 'exact'))).toBeUndefined();
    expect(memberCountText(count(undefined, 'lowerBound'))).toBeUndefined();
  });

  it('gives each kind a different line, width and label, so none relies on colour', () => {
    const kinds = [stored('T'), derived('T'), aggregate('T', count(1, 'exact')), { ...stored('T'), semantics: 'unknown' as const }].map((item) => relationshipLook(item));
    const signature = (look: ReturnType<typeof relationshipLook>) => `${look.origin}|${look.aggregate}|${look.label ?? '-'}`;
    expect(new Set(kinds.map(signature)).size).toBe(4);
  });

  it('has no count badge for an aggregate of exactly one relationship, for a count that is unknown, or for a relationship that is not an aggregate', () => {
    expect(relationshipLook(aggregate('SENT', count(1, 'exact'))).badge).toBeUndefined();
    expect(relationshipLook(aggregate('SENT', count(undefined, 'unknown'))).badge).toBeUndefined();
    expect(relationshipLook(derived('SHARES')).badge).toBeUndefined();
    expect(relationshipLook(stored('USES')).badge).toBeUndefined();
  });

  it('keeps the origin word in the label of every relationship that is not stored, so the marker follows the label', () => {
    expect(relationshipLook(derived('SHARES')).label).toBe('SHARES · derived');
    expect(relationshipLook({ ...stored('USES'), semantics: 'unknown' }).label).toBe('USES · origin unknown');
  });
});
