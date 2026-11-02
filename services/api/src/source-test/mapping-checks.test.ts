import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '../gate/templates/schema-indexes.js';
import type { SourceModel } from '../mapping/model.js';
import { baseSource, firstSource, load } from '../testing/mapping.js';
import { checksOf, entitiesToScan, judgeIndexes, judgeScan, judgeTokens, stableIdActionOf, statusOf, type SchemaReads } from './mapping-checks.js';

const source: SourceModel = firstSource(
  load(
    baseSource({
      entities: [
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'title'], reference: ['extRef'] },
        { type: 'person', label: 'Person', stable_id: 'personId' },
      ],
      relationships: [
        { type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] },
        { type: 'MADE_BY', from: 'person', to: 'person', evidence: ['recordId'] },
      ],
    }),
  ),
);

const node = (name: string, property: string, overrides: Partial<IndexEntry> = {}): IndexEntry => ({ type: 'RANGE', entityType: 'NODE', name, property, single: true, state: 'ONLINE', constrained: false, ...overrides });
const edge = (name: string, property: string, overrides: Partial<IndexEntry> = {}): IndexEntry => ({ ...node(name, property), entityType: 'RELATIONSHIP', ...overrides });

/** A schema that fits the mapping above completely. */
const FITTING: readonly IndexEntry[] = [
  node('Gadget', 'gadgetId', { constrained: true }),
  node('Gadget', 'title'),
  node('Gadget', 'extRef'),
  node('Person', 'personId', { constrained: true }),
  edge('MADE_BY', 'linkId'),
  edge('MADE_BY', 'madeAt'),
  edge('MADE_BY', 'recordId'),
];

const reads = (indexes: readonly IndexEntry[], labels: readonly string[] = ['Gadget', 'Person'], types: readonly string[] = ['MADE_BY']): SchemaReads => ({ labels: new Set(labels), types: new Set(types), indexes });
const without = (indexes: readonly IndexEntry[], drop: (entry: IndexEntry) => boolean): IndexEntry[] => indexes.filter((entry) => !drop(entry));
const checksOnly = (found: ReturnType<typeof judgeIndexes>) => found.map((entry) => entry.check);

describe('the labels and relationship types', () => {
  it('give no finding when every name exists', () => {
    expect(judgeTokens(source, reads([]))).toEqual([]);
  });

  it('name the entity type and the label that no node carries', () => {
    expect(judgeTokens(source, reads([], ['Person']))).toEqual([
      { severity: 'fail', check: 'label', entityType: 'gadget', message: 'Entity type "gadget" (label "Gadget"): no node carries the label' },
    ]);
  });

  it('name each relationship type that is missing with its from and to, once per mapping row', () => {
    expect(judgeTokens(source, reads([], ['Gadget', 'Person'], []))).toEqual([
      { severity: 'fail', check: 'relationship-type', relationshipType: 'MADE_BY', from: 'gadget', to: 'person', message: 'Relationship type "MADE_BY" from "gadget" to "person": no relationship of the type exists' },
      { severity: 'fail', check: 'relationship-type', relationshipType: 'MADE_BY', from: 'person', to: 'person', message: 'Relationship type "MADE_BY" from "person" to "person": no relationship of the type exists' },
    ]);
  });
});

describe('the indexes', () => {
  it('give no finding for a schema that fits', () => {
    expect(judgeIndexes(source, reads(FITTING))).toEqual([]);
  });

  it.each([
    ['search', 'title', 'search-index', 'Entity type "gadget" (label "Gadget"): no index on the search property "title"'],
    ['reference', 'extRef', 'reference-index', 'Entity type "gadget" (label "Gadget"): no index on the reference property "extRef"'],
  ])('fail on a missing %s index and name the property', (_kind, property, check, message) => {
    const found = judgeIndexes(source, reads(without(FITTING, (entry) => entry.name === 'Gadget' && entry.property === property)));
    expect(found).toEqual([{ severity: 'fail', check, entityType: 'gadget', property, message }]);
  });

  it('fail on a missing evidence index for each mapping row of the relationship type, with from and to', () => {
    const found = judgeIndexes(source, reads(without(FITTING, (entry) => entry.property === 'recordId')));
    expect(found.map((entry) => [entry.check, entry.from, entry.to, entry.property])).toEqual([
      ['evidence-index', 'gadget', 'person', 'recordId'],
      ['evidence-index', 'person', 'person', 'recordId'],
    ]);
  });

  it('only warn on a missing sort index', () => {
    const found = judgeIndexes(source, reads(without(FITTING, (entry) => entry.property === 'madeAt')));
    expect(found).toEqual([
      expect.objectContaining({ severity: 'warn', check: 'sort-index', relationshipType: 'MADE_BY', from: 'gadget', to: 'person', property: 'madeAt' }),
    ]);
  });

  it('accept a TEXT index for a search property', () => {
    const swapped = FITTING.map((entry) => (entry.name === 'Gadget' && entry.property === 'title' ? { ...entry, type: 'TEXT' as const } : entry));
    expect(judgeIndexes(source, reads(swapped))).toEqual([]);
  });

  it.each([
    ['a composite index', { single: false }],
    ['an index on another entity type', { name: 'Person' }],
    ['an index on a relationship type of the same name as the label', { entityType: 'RELATIONSHIP' as const }],
  ])('does not count %s', (_name, change) => {
    const found = judgeIndexes(source, reads(FITTING.map((entry) => (entry.name === 'Gadget' && entry.property === 'title' ? { ...entry, ...change } : entry))));
    expect(checksOnly(found)).toEqual(['search-index']);
  });

  it('warns that an index is still being built, and fails an index that is in any other state, without repeating the state', () => {
    const building = judgeIndexes(source, reads(FITTING.map((entry) => (entry.property === 'title' ? { ...entry, state: 'POPULATING' } : entry))));
    expect(building).toEqual([expect.objectContaining({ severity: 'warn', check: 'index-building', message: 'Entity type "gadget" (label "Gadget"): the index on the search property "title" is still being built' })]);
    const failed = judgeIndexes(source, reads(FITTING.map((entry) => (entry.property === 'title' ? { ...entry, state: 'FAILED' } : entry))));
    expect(failed).toEqual([expect.objectContaining({ severity: 'fail', check: 'index-failed', message: 'Entity type "gadget" (label "Gadget"): the index on the search property "title" cannot be used' })]);
    expect(JSON.stringify(failed)).not.toContain('FAILED');
  });

  it('counts an index that is online next to one that is not as present', () => {
    const both = [...without(FITTING, (entry) => entry.property === 'title'), node('Gadget', 'title', { state: 'FAILED' }), node('Gadget', 'title', { type: 'TEXT' })];
    expect(judgeIndexes(source, reads(both))).toEqual([]);
  });

  it('judge an entity type whose label is missing by its label only', () => {
    const found = judgeIndexes(source, reads([], ['Person'], ['MADE_BY']));
    expect(found.every((entry) => entry.entityType !== 'gadget')).toBe(true);
  });

  it('judge a relationship type that is missing by its type only', () => {
    const found = judgeIndexes(source, reads(FITTING, ['Gadget', 'Person'], []));
    expect(found.every((entry) => entry.relationshipType === undefined)).toBe(true);
  });
});

describe('the relationship stable id', () => {
  it('gives no finding with an index, whether or not a constraint backs it', () => {
    expect(judgeIndexes(source, reads(FITTING.map((entry) => (entry.property === 'linkId' ? { ...entry, constrained: true } : entry))))).toEqual([]);
    expect(judgeIndexes(source, reads(FITTING))).toEqual([]);
  });

  it('warns when there is neither', () => {
    const found = judgeIndexes(source, reads(without(FITTING, (entry) => entry.property === 'linkId')));
    expect(found).toEqual([
      expect.objectContaining({ severity: 'warn', check: 'rel-stable-id-unindexed', relationshipType: 'MADE_BY', from: 'gadget', to: 'person', property: 'linkId' }),
    ]);
  });

  it('says nothing about a relationship type with no stable id', () => {
    expect(judgeIndexes(source, reads(FITTING)).some((entry) => entry.from === 'person')).toBe(false);
  });
});

describe('the entity stable id', () => {
  const gadget = source.entities[0];
  if (gadget === undefined) throw new Error('the fixture has an entity');

  it('needs no scan with a constraint-backed index on exactly that property', () => {
    expect(stableIdActionOf(gadget, reads(FITTING))).toBe('unique');
  });

  it('is not made unique by a composite key', () => {
    expect(stableIdActionOf(gadget, reads([node('Gadget', 'gadgetId', { constrained: true, single: false })]))).toBe('unindexed');
  });

  it('is scanned with a RANGE index and no constraint', () => {
    expect(stableIdActionOf(gadget, reads([node('Gadget', 'gadgetId')]))).toBe('scan');
  });

  it.each([
    ['no index', []],
    ['a TEXT index only', [node('Gadget', 'gadgetId', { type: 'TEXT' })]],
    ['a composite RANGE index only', [node('Gadget', 'gadgetId', { single: false })]],
  ])('fails with %s, and says what would do', (_name, indexes) => {
    expect(stableIdActionOf(gadget, reads(indexes))).toBe('unindexed');
    const found = judgeIndexes(source, reads(indexes)).filter((entry) => entry.check === 'stable-id-unindexed' && entry.entityType === 'gadget');
    expect(found).toEqual([
      expect.objectContaining({ severity: 'fail', property: 'gadgetId', message: 'Entity type "gadget" (label "Gadget"): the stable id property "gadgetId" needs a uniqueness constraint or a RANGE index' }),
    ]);
  });

  it.each([
    ['still being built', 'POPULATING', 'building', 'index-building', 'warn', 'is still being built'],
    ['in a failed state', 'FAILED', 'failed', 'index-failed', 'fail', 'cannot be used'],
  ] as const)('does not scan a RANGE index that is %s, and says so with the property', (_name, state, action, check, severity, words) => {
    const indexes = [...without(FITTING, (entry) => entry.name === 'Gadget' && entry.property === 'gadgetId'), node('Gadget', 'gadgetId', { state })];
    expect(stableIdActionOf(gadget, reads(indexes))).toBe(action);
    expect(entitiesToScan(source, reads(indexes))).toEqual([]);
    const found = judgeIndexes(source, reads(indexes)).filter((entry) => entry.entityType === 'gadget' && entry.check === check && entry.message.includes('stable id property'));
    expect(found).toEqual([expect.objectContaining({ severity, message: expect.stringContaining(`stable id property "gadgetId" ${words}`) })]);
  });

  it('scans when one RANGE index is online next to one that is not', () => {
    const indexes = [...without(FITTING, (entry) => entry.name === 'Gadget' && entry.property === 'gadgetId'), node('Gadget', 'gadgetId', { state: 'FAILED' }), node('Gadget', 'gadgetId')];
    expect(stableIdActionOf(gadget, reads(indexes))).toBe('scan');
  });

  it('picks the entity types to scan: those with a label, an index and no constraint', () => {
    const indexes = [...without(FITTING, (entry) => entry.name === 'Gadget' && entry.property === 'gadgetId'), node('Gadget', 'gadgetId')];
    expect(entitiesToScan(source, reads(indexes)).map((entity) => entity.type)).toEqual(['gadget']);
    expect(entitiesToScan(source, reads(indexes, ['Person']))).toEqual([]);
    expect(entitiesToScan(source, reads(FITTING))).toEqual([]);
  });

  it('reports duplicates as a failure with the count and no value, no duplicate as a warning, and an unfinished scan as not verified', () => {
    expect(judgeScan(gadget, { duplicated: 3 })).toEqual([
      { severity: 'fail', check: 'stable-id-unique', entityType: 'gadget', property: 'gadgetId', message: 'Entity type "gadget" (label "Gadget"): 3 values occur more than once in the stable id property "gadgetId"' },
    ]);
    expect(judgeScan(gadget, { duplicated: 1 })[0]?.message).toContain('1 value occurs more than once');
    expect(judgeScan(gadget, { duplicated: 0 })).toEqual([expect.objectContaining({ severity: 'warn', check: 'stable-id-unenforced' })]);
    expect(judgeScan(gadget, 'unverified')).toEqual([expect.objectContaining({ severity: 'warn', check: 'stable-id-unverified' })]);
  });
});

describe('the status of the findings', () => {
  const fail = judgeTokens(source, reads([], ['Person']));
  const unverified = judgeScan(source.entities[0] ?? (() => { throw new Error('no entity'); })(), 'unverified');
  const warn = judgeScan(source.entities[0] ?? (() => { throw new Error('no entity'); })(), { duplicated: 0 });

  it.each([
    ['no finding', [], 'pass'],
    ['a warning', warn, 'warn'],
    ['a finding that something was not verified', unverified, 'not-verified'],
    ['a failure', fail, 'fail'],
    ['a warning and a finding that something was not verified', [...warn, ...unverified], 'not-verified'],
    ['a failure and a finding that something was not verified', [...unverified, ...fail], 'fail'],
  ] as const)('is the strongest of %s', (_name, findings, status) => {
    expect(statusOf(findings)).toBe(status);
    expect(checksOf(findings).status).toBe(status);
  });
});
