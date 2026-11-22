import type { GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { bounded, loadedRange, readBound, satisfies, type RangeCondition } from './property-filter.js';
import { node, ref } from './test-data.js';

const prop = (value: unknown, dataClass: GraphProperty['dataClass'], masked = false): GraphProperty => ({ key: 'score', value, dataClass, masked });
const range = (kind: RangeCondition['kind'], from?: string, to?: string): RangeCondition => ({ on: 'entity', type: 'kind-a', property: 'score', kind, op: 'between', from, to });

describe('a number range', () => {
  it('keeps the values at or above from, at or below to, with the bounds themselves in', () => {
    const between = range('number', '1000', '5000');
    for (const value of ['1000', '1000.0', 1000, '2450.5', '5000', 5000]) expect(satisfies(between, prop(value, 'number'))).toBe(true);
    for (const value of ['999.99', '5000.01', 999, '-1']) expect(satisfies(between, prop(value, 'number'))).toBe(false);
  });

  it('works with only one end set', () => {
    expect(satisfies(range('number', '10'), prop('10', 'number'))).toBe(true);
    expect(satisfies(range('number', '10'), prop('9', 'number'))).toBe(false);
    expect(satisfies(range('number', undefined, '10'), prop('11', 'number'))).toBe(false);
    expect(satisfies(range('number', undefined, '10'), prop('-5', 'number'))).toBe(true);
  });

  it('is exact beyond 2^53 and for a long fraction, which a JavaScript number cannot tell apart', () => {
    expect(satisfies(range('number', '9007199254740993'), prop('9007199254740992', 'number'))).toBe(false);
    expect(satisfies(range('number', '9007199254740993'), prop('9007199254740993', 'number'))).toBe(true);
    expect(satisfies(range('number', undefined, '0.1000000000000000000001'), prop('0.1', 'number'))).toBe(true);
    expect(satisfies(range('number', '0.1000000000000000000001'), prop('0.1', 'number'))).toBe(false);
  });

  it('never matches a masked value, a missing one, one of another class, or NaN and the infinities', () => {
    const between = range('number', '0', '100');
    expect(satisfies(between, prop('50', 'number', true))).toBe(false);
    expect(satisfies(between, undefined)).toBe(false);
    expect(satisfies(between, prop(null, 'number'))).toBe(false);
    expect(satisfies(between, prop('50', 'text'))).toBe(false);
    for (const value of [Number.NaN, 'NaN', 'Infinity', '-Infinity', Number.POSITIVE_INFINITY]) expect(satisfies(range('number', undefined, '100'), prop(value, 'number'))).toBe(false);
  });
});

describe('date and time ranges', () => {
  it('compares a dateTime as an instant to the nanosecond, with a tie at a bound in and a zone suffix read', () => {
    const between = range('dateTime', '2026-03-01T12:00:00Z', '2026-03-01T14:00:00Z');
    expect(satisfies(between, prop('2026-03-01T13:00:00+01:00', 'dateTime'))).toBe(true);
    expect(satisfies(between, prop('2026-03-01T14:00:00Z', 'dateTime'))).toBe(true);
    expect(satisfies(between, prop('2026-03-01T14:00:00.000000001Z', 'dateTime'))).toBe(false);
    expect(satisfies(between, prop('2026-03-01T11:59:59.999999999Z', 'dateTime'))).toBe(false);
    expect(satisfies(between, prop('2026-03-01T13:00:00Z[Europe/Paris]', 'dateTime'))).toBe(true);
  });

  it('compares local kinds by their text with the fraction padded, a date by day, and a zoned time as an instant', () => {
    expect(satisfies(range('localTime', '10:00:00.5'), prop('10:00:00.50', 'localTime'))).toBe(true);
    expect(satisfies(range('localTime', '10:00:00.5'), prop('10:00:00.123456789', 'localTime'))).toBe(false);
    expect(satisfies(range('date', '2026-03-01', '2026-03-31'), prop('2026-03-31', 'date'))).toBe(true);
    expect(satisfies(range('date', '2026-03-01', '2026-03-31'), prop('2026-04-01', 'date'))).toBe(false);
    expect(satisfies(range('localDateTime', '2026-03-01T10:00:00'), prop('2026-03-01T10:00:00.000000001', 'localDateTime'))).toBe(true);
    expect(satisfies(range('time', '12:00:00Z'), prop('13:00:00+01:00', 'time'))).toBe(true);
  });

  it('does not match a value of another class or one that cannot be read', () => {
    expect(satisfies(range('dateTime', '2026-03-01T12:00:00Z'), prop('2026-03-01T13:00:00Z', 'date'))).toBe(false);
    expect(satisfies(range('dateTime', '2026-03-01T12:00:00Z'), prop('yesterday', 'dateTime'))).toBe(false);
    expect(satisfies(range('date', '2026-03-01'), prop('2026-02-30', 'text'))).toBe(false);
  });
});

describe('reading a typed bound', () => {
  it('accepts decimal text of any length for a number and refuses a separator, an exponent and letters', () => {
    expect(readBound('number', ' 1000 ')).toEqual({ ok: true, text: '1000' });
    expect(readBound('number', '9007199254740993')).toEqual({ ok: true, text: '9007199254740993' });
    for (const text of ['1,000', '1e3', 'ten', '', '1.']) expect(readBound('number', text).ok).toBe(false);
  });

  it('accepts the product\'s ISO text for a temporal kind and refuses anything else', () => {
    expect(readBound('date', '2026-03-01').ok).toBe(true);
    expect(readBound('dateTime', '2026-03-01T10:00:00Z').ok).toBe(true);
    expect(readBound('dateTime', '2026-03-01').ok).toBe(false);
    expect(readBound('time', '10:00:00').ok).toBe(false);
    expect(readBound('localTime', '10:00:00').ok).toBe(true);
    expect(readBound('date', 'March 1').ok).toBe(false);
  });

  it('tells a from later than to', () => {
    expect(bounded('number', '10', '5')).toBe(true);
    expect(bounded('number', '5', '10')).toBe(false);
    expect(bounded('date', '2026-03-02', '2026-03-01')).toBe(true);
  });
});

describe('the lowest and highest loaded value', () => {
  const held = (id: string, value: unknown, masked = false) => ({ ...node('a', id), ref: ref('a', 'kind-a', id), properties: [prop(value, 'number', masked)] });

  it('skips a value that cannot be read, so one NaN or an unreadable time never hides the bounds', () => {
    expect(loadedRange([held('1', 'NaN'), held('2', '3'), held('3', 'Infinity'), held('4', '8')], 'score', 'number')).toEqual({ lowest: '3', highest: '8' });
  });

  it('are written as canonical text, and nothing is given when any loaded value is masked or none is comparable', () => {
    expect(loadedRange([held('1', '9'), held('2', '10'), held('3', 2.5)], 'score', 'number')).toEqual({ lowest: '2.5', highest: '10' });
    expect(loadedRange([held('1', '9'), held('2', '10', true)], 'score', 'number')).toBeUndefined();
    expect(loadedRange([held('1', null)], 'score', 'number')).toBeUndefined();
    expect(loadedRange([], 'score', 'number')).toBeUndefined();
  });
});
