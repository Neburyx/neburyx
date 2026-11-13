import { describe, expect, it } from 'vitest';
import { MAX_MAPPING_BYTES, parseMapping } from './load.js';
import { baseSource, expectRefused, fileOf, firstSource, load, type Json } from '../testing/mapping.js';

const entity = (extra: Json = {}): Json => ({ type: 'node_c', label: 'NodeC', stable_id: 'id', filterable: ['status', 'size'], ...extra });
const relationship = (extra: Json = {}): Json => ({ type: 'LINKS', from: 'node_c', to: 'node_c', observed_at: 'seenAt', filterable: ['kind'], ...extra });
const sourceOf = (e: Json = {}, r: Json = {}): Json => baseSource({ entities: [entity(e)], relationships: [relationship(r)] });

/** The hash this source had before kinds existed (the same value on the previous image). */
const HASH_WITHOUT_KINDS = 'cf3db9e53d3bfdcf8cc0ec42be0acb41ff073ddc11656d75fe3ebb72f1e12eba';
const legacy = (): Json => baseSource({ entities: [{ type: 'node_c', label: 'NodeC', stable_id: 'id', filterable: ['status'] }], relationships: [{ type: 'LINKS', from: 'node_c', to: 'node_c', observed_at: 'seenAt', filterable: ['kind'] }] });

describe('the property kinds a mapping declares', () => {
  it('holds the declared kinds of an entity type and of a relationship row, and no key when none are declared', () => {
    const declared = firstSource(load(sourceOf({ kinds: { size: 'number' } }, { kinds: { kind: 'text', seenAt: 'dateTime' } })));
    expect(declared.entities[0]?.kinds).toEqual({ size: 'number' });
    expect(declared.relationships[0]?.kinds).toEqual({ kind: 'text', seenAt: 'dateTime' });
    const plain = firstSource(load(sourceOf()));
    expect('kinds' in (plain.entities[0] ?? {})).toBe(false);
    expect('kinds' in (plain.relationships[0] ?? {})).toBe(false);
  });

  it('keeps the configuration hash of a mapping without kinds, and changes it when kinds are declared', () => {
    expect(firstSource(load(legacy())).configHash).toBe(HASH_WITHOUT_KINDS);
    expect(firstSource(load(sourceOf({ filterable: ['status'] }, { kinds: {} }))).configHash).toBe(HASH_WITHOUT_KINDS);
    expect(firstSource(load(sourceOf({ filterable: ['status'], kinds: { status: 'text' } }, {}))).configHash).not.toBe(HASH_WITHOUT_KINDS);
  });

  it('refuses a key that is not a filterable property of the type, and a time property on a row that has none', () => {
    expectRefused(sourceOf({ kinds: { other: 'text' } }), 'sources[0].entities[0].kinds.other', 'not a filterable property');
    expectRefused(sourceOf({}, { kinds: { other: 'text' } }), 'sources[0].relationships[0].kinds.other', 'not a filterable property');
    expectRefused(sourceOf({}, { observed_at: undefined, kinds: { seenAt: 'dateTime' } }), 'sources[0].relationships[0].kinds.seenAt', 'not a filterable property');
  });

  it('refuses a value outside the filter kinds and a document that is not a map', () => {
    expectRefused(sourceOf({ kinds: { size: 'integer' } }), 'sources[0].entities[0].kinds.size', 'must be one of');
    expectRefused(sourceOf({ kinds: { size: 'unknown' } }), 'sources[0].entities[0].kinds.size', 'must be one of');
    for (const hostile of [['text'], 'text', 7, null, { 'a}b': 'text' }, { '': 'text' }]) {
      expect(() => parseMapping(fileOf(sourceOf({ kinds: hostile })), 'neburyx.yaml')).toThrow();
    }
  });

  it('survives hostile keys without a crash: a prototype key is only a name that is not filterable', () => {
    const hostile = JSON.parse('{"__proto__": "text", "constructor": "text"}') as Json;
    expect(() => parseMapping(fileOf(sourceOf({ kinds: hostile })), 'neburyx.yaml')).toThrow();
    expect(({} as Record<string, unknown>)['text']).toBeUndefined();
  });

  it('refuses a very large map of kinds without a crash, as keys that are not filterable, and a document over the size limit by its size', () => {
    const huge = Object.fromEntries(Array.from({ length: 2_000 }, (_unused, index) => [`p${index}`, 'text']));
    expect(() => parseMapping(fileOf(sourceOf({ kinds: huge })), 'neburyx.yaml')).toThrow('not a filterable property');
    expect(() => parseMapping(`# ${'x'.repeat(MAX_MAPPING_BYTES + 1)}\n${fileOf(sourceOf({ kinds: { size: 'text' } }))}`, 'neburyx.yaml')).toThrow('larger than');
  });

  it('keeps a declared kind of a property named like a built-in object member as data, and never lets `__proto__` change a prototype', () => {
    const declared = firstSource(load(sourceOf({ filterable: ['constructor', '__proto__'], kinds: JSON.parse('{"constructor": "text", "__proto__": "number"}') as Json })));
    const kinds = declared.entities[0]?.kinds ?? {};
    expect(kinds['constructor']).toBe('text');
    expect(Object.getPrototypeOf(kinds)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['number']).toBeUndefined();
  });
});
