import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { plainRow, plainValue } from './plain-values.js';

const { types } = neo4j;
const int = (value: string | number) => neo4j.int(value);

describe('a driver value as the gate sees it', () => {
  it.each([
    ['null', null, null],
    ['undefined', undefined, null],
    ['true', true, true],
    ['text', 'abc', 'abc'],
    ['a float', 1.5, 1.5],
    ['zero', 0, 0],
  ])('keeps %s', (_name, value, expected) => {
    expect(plainValue(value)).toEqual(expected);
  });

  it('turns an integer within the safe range into a number', () => {
    expect(plainValue(int(0))).toBe(0);
    expect(plainValue(int(-42))).toBe(-42);
    expect(plainValue(int('9007199254740991'))).toBe(9_007_199_254_740_991);
    expect(plainValue(int('-9007199254740991'))).toBe(-9_007_199_254_740_991);
  });

  it('keeps the exact digits of an integer beyond the safe range, never a rounded number', () => {
    expect(plainValue(int('9007199254740992'))).toEqual({ $type: 'integer', value: '9007199254740992' });
    expect(plainValue(int('9223372036854775807'))).toEqual({ $type: 'integer', value: '9223372036854775807' });
    expect(plainValue(int('-9223372036854775808'))).toEqual({ $type: 'integer', value: '-9223372036854775808' });
    expect(plainValue(9_223_372_036_854_775_807n)).toEqual({ $type: 'integer', value: '9223372036854775807' });
  });

  it.each([[Number.NaN, 'NaN'], [Number.POSITIVE_INFINITY, 'Infinity'], [Number.NEGATIVE_INFINITY, '-Infinity']])('tags the non-finite float %s', (value, text) => {
    expect(plainValue(value)).toEqual({ $type: 'float', value: text });
  });

  it('tags each temporal value with its kind and its ISO-8601 text', () => {
    expect(plainValue(new types.Date(2026, 1, 2))).toEqual({ $type: 'date', value: '2026-01-02' });
    expect(plainValue(new types.DateTime(2026, 1, 2, 3, 4, 5, 123_456_789, 7200, undefined))).toEqual({ $type: 'dateTime', value: '2026-01-02T03:04:05.123456789+02:00' });
    expect(plainValue(new types.LocalDateTime(2026, 1, 2, 3, 4, 5, 0))).toEqual({ $type: 'localDateTime', value: '2026-01-02T03:04:05' });
    expect(plainValue(new types.Time(10, 11, 12, 0, 0))).toEqual({ $type: 'time', value: '10:11:12Z' });
    expect(plainValue(new types.LocalTime(10, 11, 12, 0))).toEqual({ $type: 'localTime', value: '10:11:12' });
    expect(plainValue(new types.Duration(14, 3, 14706, 0))).toEqual({ $type: 'duration', value: 'P1Y2M3DT4H5M6S' });
  });

  it('tags a point with its reference system and coordinates, and z when it has one', () => {
    expect(plainValue(new types.Point(int(7203), 1.5, 2.5))).toEqual({ $type: 'point', srid: 7203, x: 1.5, y: 2.5 });
    expect(plainValue(new types.Point(int(9157), 1.5, 2.5, 3))).toEqual({ $type: 'point', srid: 9157, x: 1.5, y: 2.5, z: 3 });
  });

  it('turns a node into its labels and properties, converted, with its element ID', () => {
    const node = new types.Node(int(1), ['L'], { n: int(2), when: new types.Date(2026, 1, 2) }, 'e1');
    expect(plainValue(node)).toEqual({ $type: 'node', elementId: 'e1', labels: ['L'], properties: { n: 2, when: { $type: 'date', value: '2026-01-02' } } });
  });

  it('turns a relationship into its type, its two end element IDs and its properties', () => {
    const rel = new types.Relationship(int(5), int(1), int(2), 'T', { w: int('9223372036854775807') }, 'r1', 'e1', 'e2');
    expect(plainValue(rel)).toEqual({ $type: 'relationship', elementId: 'r1', type: 'T', startElementId: 'e1', endElementId: 'e2', properties: { w: { $type: 'integer', value: '9223372036854775807' } } });
  });

  it('turns a path into its start node and the relationship and node of each segment', () => {
    const a = new types.Node(int(1), ['L'], {}, 'e1');
    const b = new types.Node(int(2), ['L'], {}, 'e2');
    const r = new types.Relationship(int(5), int(1), int(2), 'T', {}, 'r1', 'e1', 'e2');
    const path = new types.Path(a, b, [new types.PathSegment(a, r, b)]);
    expect(plainValue(path)).toEqual({
      $type: 'path',
      start: { $type: 'node', elementId: 'e1', labels: ['L'], properties: {} },
      segments: [{ relationship: { $type: 'relationship', elementId: 'r1', type: 'T', startElementId: 'e1', endElementId: 'e2', properties: {} }, end: { $type: 'node', elementId: 'e2', labels: ['L'], properties: {} } }],
    });
  });

  it('converts every level of a list and of a map', () => {
    const value = [int(1), { deep: [new types.Date(2026, 1, 2), { deeper: int('9223372036854775807') }] }, null];
    expect(plainValue(value)).toEqual([1, { deep: [{ $type: 'date', value: '2026-01-02' }, { deeper: { $type: 'integer', value: '9223372036854775807' } }] }, null]);
  });

  it('turns a value it does not know into an unsupported tag, and keeps the rest of the row', () => {
    class Strange {
      readonly secret = 'VALUE';
    }
    const row = plainRow({ ok: int(1), odd: new Strange(), fn: () => 1, list: [new Strange()] });
    expect(row).toEqual({ ok: 1, odd: { $type: 'unsupported' }, fn: { $type: 'unsupported' }, list: [{ $type: 'unsupported' }] });
    expect(JSON.stringify(row)).not.toContain('VALUE');
  });

  it('gives a row that survives a JSON round trip unchanged', () => {
    const row = plainRow({ a: int('9223372036854775807'), b: new types.DateTime(2026, 1, 2, 3, 4, 5, 0, 0, undefined), c: [new types.Point(int(7203), 1, 2)], d: Number.NaN });
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });
});
