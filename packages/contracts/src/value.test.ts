import { describe, expect, it } from 'vitest';
import { canonicalNumberText, compareNumbers, compareStyleValue, isDecimalText, isOrdered, type StyleValue } from './value.js';

const number = (value: number | string): StyleValue => ({ class: 'number', value: value as number });
const rule = (kind: StyleValue['class'], value: string | number | boolean): StyleValue => ({ class: kind, value });

describe('comparing a node value with a rule value', () => {
  it('compares numbers by numeric value whatever their text, a tagged integer and a float included', () => {
    expect(compareStyleValue(number(2000), 'number', '2450')).toBe(1);
    expect(compareStyleValue(number(2000), 'number', 2000)).toBe(0);
    expect(compareStyleValue(number(2000), 'number', '2000.0')).toBe(0);
    expect(compareStyleValue(number(2000.5), 'number', '2000')).toBe(-1);
    expect(compareStyleValue(number(1), 'number', '1e0')).toBe(0);
    expect(compareStyleValue(number(-5), 'number', '-7')).toBe(-1);
    expect(compareStyleValue(number(-5), 'number', '-3.5')).toBe(1);
    expect(compareStyleValue(number(0), 'number', '-0')).toBe(0);
  });

  it('is exact for an integer beyond 2^53, which a float cannot tell from its neighbour', () => {
    expect(compareStyleValue(number(9007199254740991), 'number', '9007199254740993')).toBe(1);
    expect(compareStyleValue(number('9007199254740993' as unknown as number), 'number', '9007199254740992')).toBe(-1);
  });

  it('gives no answer for another data class, which is never a match, and nothing is coerced', () => {
    expect(compareStyleValue(rule('text', '2450'), 'number', 2450)).toBeUndefined();
    expect(compareStyleValue(number(2450), 'text', '2450')).toBeUndefined();
    expect(compareStyleValue(rule('boolean', true), 'text', 'true')).toBeUndefined();
    expect(compareStyleValue(number(1), 'number', 'not a number')).toBeUndefined();
    expect(compareStyleValue(number(1), 'number', Number.NaN)).toBeUndefined();
    expect(compareStyleValue(number(1), 'number', null)).toBeUndefined();
  });

  it('compares text and booleans for equality', () => {
    expect(compareStyleValue(rule('text', 'review'), 'text', 'review')).toBe(0);
    expect(compareStyleValue(rule('text', 'review'), 'text', 'Review')).not.toBe(0);
    expect(compareStyleValue(rule('boolean', true), 'boolean', true)).toBe(0);
    expect(compareStyleValue(rule('boolean', true), 'boolean', false)).toBe(-1);
  });

  it('compares two dateTime values with different offsets as instants', () => {
    const noon = rule('dateTime', '2026-03-01T12:00:00Z');
    expect(compareStyleValue(noon, 'dateTime', '2026-03-01T13:00:00+01:00')).toBe(0);
    expect(compareStyleValue(noon, 'dateTime', '2026-03-01T13:00:00Z')).toBe(1);
    expect(compareStyleValue(noon, 'dateTime', '2026-03-01T12:00:00.5Z')).toBe(1);
    expect(compareStyleValue(noon, 'dateTime', '2026-03-01T12:00:00Z[Europe/Paris]')).toBe(0);
    expect(compareStyleValue(noon, 'dateTime', 'yesterday')).toBeUndefined();
  });

  it('compares local values by a key whose fraction is padded, never as plain text', () => {
    const base = rule('localTime', '10:00:00.5');
    expect(compareStyleValue(base, 'localTime', '10:00:00.50')).toBe(0);
    expect(compareStyleValue(base, 'localTime', '10:00:00.123456789')).toBe(-1);
    expect(compareStyleValue(rule('localDateTime', '2026-03-01T10:00:00'), 'localDateTime', '2026-03-01T10:00:00.000000001')).toBe(1);
    expect(compareStyleValue(rule('date', '2026-03-01'), 'date', '2026-03-02')).toBe(1);
    expect(compareStyleValue(rule('date', '2026-03-01'), 'date', '2026-03-01')).toBe(0);
  });

  it('compares a zoned time as seconds since midnight UTC', () => {
    const zoned = rule('time', '12:00:00Z');
    expect(compareStyleValue(zoned, 'time', '13:00:00+01:00')).toBe(0);
    expect(compareStyleValue(zoned, 'time', '12:00:01Z')).toBe(1);
    expect(compareStyleValue(zoned, 'time', '12:00')).toBeUndefined();
  });

  it('says which classes order', () => {
    expect(['number', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'].every((kind) => isOrdered(kind as StyleValue['class']))).toBe(true);
    expect(isOrdered('text')).toBe(false);
    expect(isOrdered('boolean')).toBe(false);
  });
});

describe('the decimal-text rule and the canonical number text', () => {
  it('accepts a sign, digits and a fraction of any length and refuses the rest', () => {
    for (const text of ['0', '-5', '+5', '1000', '999.5', '9007199254740993', '123456789012345678901234567890.000000001']) expect(isDecimalText(text)).toBe(true);
    for (const text of ['', ' ', '1,000', '1e5', '1E-7', 'abc', '1.', '.5', '--1', '1 000', '0x10']) expect(isDecimalText(text)).toBe(false);
  });

  it('writes a number as its expanded decimal, never in exponent form, and each text passes the rule', () => {
    expect(canonicalNumberText(1e21)).toBe('1000000000000000000000');
    expect(canonicalNumberText(1e-7)).toBe('0.0000001');
    expect(canonicalNumberText(2000.0)).toBe('2000');
    expect(canonicalNumberText('2000.50')).toBe('2000.5');
    expect(canonicalNumberText('-0')).toBe('0');
    expect(canonicalNumberText('9007199254740993')).toBe('9007199254740993');
    for (const value of [1e21, 1e-7, 123.456, -0.5, '00012.3400']) expect(isDecimalText(canonicalNumberText(value) ?? '')).toBe(true);
  });

  it('gives no text for NaN, the infinities or what is not a number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'NaN', 'Infinity', '-Infinity', null, undefined, {}, 'abc']) expect(canonicalNumberText(value)).toBeUndefined();
  });

  it('compares numbers exactly beyond 2^53 and never matches a non-finite value', () => {
    expect(compareNumbers('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareNumbers(1e21, '1000000000000000000000')).toBe(0);
    expect(compareNumbers(Number.NaN, 1)).toBeUndefined();
    expect(compareNumbers('Infinity', 1)).toBeUndefined();
    expect(compareNumbers('0.1', '0.10')).toBe(0);
  });
});
