import { describe, expect, it } from 'vitest';
import { refinementKey } from '../api/expand-store.js';
import { testProfile } from '../dev/test-profile.js';
import { declaredProperties, detectKind, emptyDraft, readDraft, readDrafts, readValue } from './expand-refine.js';

const fail = (message: string): never => {
  throw new Error(message);
};

describe('the kind that typed text reads as', () => {
  it.each([
    ['high', 'text'],
    ['', 'text'],
    ['12', 'number'],
    ['-0.5', 'number'],
    ['true', 'boolean'],
    ['2026-03-01', 'date'],
    ['2026-03-01T10:00:00Z', 'dateTime'],
    ['2026-03-01T10:00:00', 'localDateTime'],
    ['10:30:00Z', 'time'],
    ['10:30', 'localTime'],
    ['2026-02-30', 'text'],
    ['1e3', 'text'],
  ])('reads %j as %s', (text, kind) => expect(detectKind(text)).toBe(kind));
});

describe('a value', () => {
  it('is read as the kind asked, and says what is wrong when it is not of that kind', () => {
    expect(readValue('12', 'text')).toEqual({ ok: true, value: { kind: 'text', value: '12' } });
    expect(readValue('12', 'auto')).toEqual({ ok: true, value: { kind: 'number', value: 12 } });
    expect(readValue('abc', 'number')).toMatchObject({ ok: false, reason: 'Enter a number.' });
    expect(readValue('9007199254740993', 'number')).toMatchObject({ ok: false });
    expect(readValue('maybe', 'boolean')).toMatchObject({ ok: false, reason: 'Enter true or false.' });
    expect(readValue('2026-03-01', 'dateTime')).toMatchObject({ ok: false });
    expect(readValue('', 'auto')).toMatchObject({ ok: false, reason: 'Enter a value.' });
    expect(readValue('', 'text')).toEqual({ ok: true, value: { kind: 'text', value: '' } });
  });

  it('refuses a text longer than the contract allows, and accepts one of exactly that length', () => {
    expect(readValue('x'.repeat(256), 'text')).toMatchObject({ ok: true });
    expect(readValue('x'.repeat(257), 'text')).toEqual({ ok: false, reason: 'Enter at most 256 characters.' });
  });
});

describe('a filter row', () => {
  const draft = (change: object) => ({ ...emptyDraft(1, 'neighbor', 'band'), ...change });

  it('becomes the filter it stands for, for each operator', () => {
    expect(readDraft(draft({ text: 'high' }))).toEqual({ ok: true, filter: { on: 'neighbor', property: 'band', op: 'eq', value: { kind: 'text', value: 'high' } } });
    expect(readDraft(draft({ op: 'in', text: '1, 2,3' }))).toEqual({ ok: true, filter: { on: 'neighbor', property: 'band', op: 'in', values: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }, { kind: 'number', value: 3 }] } });
    expect(readDraft(draft({ op: 'between', from: '10', to: '' }))).toEqual({ ok: true, filter: { on: 'neighbor', property: 'band', op: 'between', from: { kind: 'number', value: 10 } } });
  });

  it('is refused with one reason for what the server would refuse', () => {
    expect(readDraft(draft({ op: 'between' }))).toMatchObject({ ok: false, reason: 'Enter a start, an end, or both.' });
    expect(readDraft(draft({ op: 'between', from: '1', to: 'x' }))).toMatchObject({ ok: false });
    expect(readDraft(draft({ op: 'between', from: 'true' }))).toMatchObject({ ok: false, reason: 'A range does not apply to true or false.' });
    expect(readDraft(draft({ op: 'in', text: '1, a' }))).toMatchObject({ ok: false });
    expect(readDraft(draft({ op: 'in', text: Array.from({ length: 21 }, (_unused, index) => index).join(',') }))).toMatchObject({ ok: false });
    expect(readDraft(draft({ op: 'in', text: '' }))).toMatchObject({ ok: false });
  });

  it('is kept in the list of problems by its ID, while the whole rows are read', () => {
    const read = readDrafts([draft({ id: 1, text: 'high' }), draft({ id: 2, text: '' })]);
    expect(read.filters).toHaveLength(1);
    expect([...read.problems.keys()]).toEqual([2]);
  });
});

describe('the properties the panel offers', () => {
  const base = testProfile('a', ['type-a', 'type-b', 'type-c']);
  const entity = (type: string, extra: object) => ({ ...(base.entityTypes.find((entry) => entry.type === type) ?? base.entityTypes[0] ?? fail('no entity type')), ...extra });
  const profile = {
    ...base,
    entityTypes: [entity('type-a', {}), entity('type-b', { filterable: ['band', 'secret'], sortable: ['size', 'secret'], pii: ['secret'] }), entity('type-c', { filterable: ['band'], sortable: [] })],
    relationshipTypes: [
      { type: 'link-a', from: 'type-a', to: 'type-b', aggregate: false, observedAt: 'seenAt', filterable: ['score'], sortable: ['points'], evidence: [], properties: [], stableIdProperty: null },
      { type: 'link-c', from: 'type-a', to: 'type-c', aggregate: true, observedAt: null, filterable: ['score', 'weight'], sortable: [], evidence: [], properties: [], stableIdProperty: null },
    ],
  };

  it('is a neighbor property that every ticked type declares, and a relationship property that every row read declares, with the observed time counted as declared', () => {
    expect(declaredProperties(profile, 'type-a', ['type-b'], undefined, 'filterable', false)).toEqual({ neighbor: ['band', 'secret'], relationship: ['score', 'seenAt'] });
    expect(declaredProperties(profile, 'type-a', ['type-b', 'type-c'], undefined, 'filterable', false)).toEqual({ neighbor: ['band'], relationship: ['score'] });
    expect(declaredProperties(profile, 'type-a', ['type-b', 'type-c'], ['link-c'], 'filterable', false)).toEqual({ neighbor: ['band'], relationship: ['score', 'weight'] });
    expect(declaredProperties(profile, 'type-a', ['type-b'], undefined, 'sortable', false)).toEqual({ neighbor: ['size', 'secret'], relationship: ['points', 'seenAt'] });
    expect(declaredProperties(profile, 'type-a', ['type-c'], undefined, 'sortable', false)).toEqual({ neighbor: [], relationship: [] });
  });

  it('leaves out a personal-data property while masking is on, and offers nothing for no ticked type', () => {
    expect(declaredProperties(profile, 'type-a', ['type-b'], undefined, 'filterable', true).neighbor).toEqual(['band']);
    expect(declaredProperties(profile, 'type-a', ['type-b'], undefined, 'sortable', true).neighbor).toEqual(['size']);
    expect(declaredProperties(profile, 'type-a', [], undefined, 'filterable', false)).toEqual({ neighbor: [], relationship: [] });
    expect(declaredProperties(undefined, 'type-a', ['type-b'], undefined, 'filterable', false)).toEqual({ neighbor: [], relationship: [] });
  });
});

describe('the text of a refinement', () => {
  const one = { on: 'neighbor' as const, property: 'band', op: 'eq' as const, value: { kind: 'text' as const, value: 'a' } };
  const two = { on: 'relationship' as const, property: 'score', op: 'eq' as const, value: { kind: 'number' as const, value: 1 } };

  it('is the same for the same filters in another order, and differs for another filter or another rank', () => {
    expect(refinementKey({ filters: [one, two], rank: undefined })).toBe(refinementKey({ filters: [two, one], rank: undefined }));
    expect(refinementKey({ filters: [one], rank: undefined })).not.toBe(refinementKey({ filters: [two], rank: undefined }));
    expect(refinementKey({ filters: [one], rank: undefined })).not.toBe(refinementKey({ filters: [one], rank: { on: 'neighbor', property: 'size', order: 'asc' } }));
    expect(refinementKey(undefined)).toBe(refinementKey({ filters: [], rank: undefined }));
  });
});
