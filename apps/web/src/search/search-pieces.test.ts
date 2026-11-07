import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER_HASH, queryKeyText } from '../state/keys.js';
import { source } from '../test-utils.js';
import { countText, matchesText, secondsText } from './count-label.js';
import { summaryOf } from './hit-summary.js';
import { hit, profiled, TYPE } from './search-test-kit.js';
import { searchKeyOf, searchKeyText } from './search-key.js';
import { NO_SELECTION } from './selection.js';
import { chooseSearchSource } from './search-source.js';

describe('the key of a search', () => {
  const identity = { sourceId: 'demo', principalId: 'p-1', text: 'AC-1', mask: false, selection: NO_SELECTION };

  it('carries the source, the person, the text and the mask', () => {
    expect(searchKeyOf(identity)).toMatchObject({ sourceId: 'demo', principalId: 'p-1', filterHash: DEFAULT_FILTER_HASH, mask: false });
    expect(searchKeyOf(identity).params).toContain('AC-1');
  });

  it('is a different key for a masked search, for another text, for another source and for another person', () => {
    const keys = [identity, { ...identity, mask: true }, { ...identity, text: 'AC-2' }, { ...identity, sourceId: 'other' }, { ...identity, principalId: 'p-2' }].map(searchKeyText);
    expect(new Set(keys).size).toBe(5);
    expect(searchKeyText(identity)).toBe(queryKeyText(searchKeyOf(identity)));
  });

  it('is a different key for a different selection of entity types or of match modes, and the same key for the same selection', () => {
    const narrowed = { ...identity, selection: { entityTypes: ['kind-a'], matchModes: [] } };
    expect(searchKeyText(narrowed)).not.toBe(searchKeyText(identity));
    expect(searchKeyText({ ...identity, selection: { entityTypes: [], matchModes: ['exact'] } })).not.toBe(searchKeyText(identity));
    expect(searchKeyText({ ...identity, selection: { entityTypes: ['kind-a'], matchModes: [] } })).toBe(searchKeyText(narrowed));
    expect(searchKeyText({ ...identity, selection: { entityTypes: ['kind-a', 'kind-b'], matchModes: [] } })).not.toBe(searchKeyText({ ...identity, selection: { entityTypes: ['kind-a'], matchModes: ['related'] } }));
  });
});

describe('the source a search reads', () => {
  const items = [source('b', { alias: 'Beta' }), source('a', { alias: 'Alpha' }), source('c', { alias: 'Alpha' })];

  it('is the one the link names, and a link naming one that is not configured is not searched', () => {
    expect(chooseSearchSource(items, 'b', 'a')).toMatchObject({ kind: 'chosen', source: { id: 'b' }, completesUrl: false });
    expect(chooseSearchSource(items, 'zz', 'a')).toEqual({ kind: 'unknown', sourceId: 'zz' });
  });

  it('is, without a link, the source of the investigation opened last when it is configured, else the first by name, then by ID', () => {
    expect(chooseSearchSource(items, null, 'b')).toMatchObject({ kind: 'chosen', source: { id: 'b' }, completesUrl: true });
    expect(chooseSearchSource(items, null, 'gone')).toMatchObject({ kind: 'chosen', source: { id: 'a' }, completesUrl: true });
    expect(chooseSearchSource(items, null, null)).toMatchObject({ kind: 'chosen', source: { id: 'a' } });
  });

  it('is none when no source is configured', () => {
    expect(chooseSearchSource([], null, null)).toEqual({ kind: 'none' });
    expect(chooseSearchSource([], 'a', null)).toEqual({ kind: 'unknown', sourceId: 'a' });
  });
});

describe('the words for a count', () => {
  it('says an exact count as the number and a lower bound as "≥ n · lower bound", and nothing for another quality', () => {
    expect(countText({ value: 3, quality: 'exact', scope: 's' })).toBe('3');
    expect(countText({ value: 25, quality: 'lowerBound', scope: 's' })).toBe('≥ 25 · lower bound');
    expect(countText({ value: 25, quality: 'estimated', scope: 's' })).toBeUndefined();
    expect(countText({ quality: 'unknown', scope: 's' })).toBeUndefined();
  });

  it('says matches in the singular for one', () => {
    expect(matchesText({ value: 1, quality: 'exact', scope: 's' })).toBe('1 exact match');
    expect(matchesText({ value: 0, quality: 'exact', scope: 's' })).toBe('0 exact matches');
    expect(matchesText({ value: 25, quality: 'lowerBound', scope: 's' })).toBe('≥ 25 exact matches · lower bound');
  });

  it('says the time in seconds with two decimals', () => {
    expect(secondsText(180)).toBe('0.18 s');
    expect(secondsText(2500)).toBe('2.50 s');
    expect(secondsText(0)).toBe('0.00 s');
  });
});

describe('the one line a hit shows', () => {
  const type = profiled('demo').entityTypes.find((candidate) => candidate.type === TYPE);

  it('is the state, then the key properties, as the profile names them, with each value once', () => {
    expect(summaryOf(hit('demo', 'AC-1', { tier: 'gold', status: 'open', stableCode: 'AC-1', other: 'x' }), type)).toEqual(['open', 'AC-1', 'gold']);
  });

  it('leaves out a property the node lacks and a value that is not text, a number or a boolean', () => {
    expect(summaryOf(hit('demo', 'AC-1', { status: { nested: true }, tier: 3 }), type)).toEqual(['3']);
    expect(summaryOf(hit('demo', 'AC-1'), type)).toEqual([]);
  });

  it('is empty when the profile does not know the type', () => {
    expect(summaryOf(hit('demo', 'AC-1', { status: 'open' }), undefined)).toEqual([]);
  });
});
