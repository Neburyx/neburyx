import type { GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildRows, isQuiet, propertyCell, shareNoProperty, statusOf, type CompareElement, type Extra } from './compare-model.js';

const prop = (key: string, value: unknown, dataClass: GraphProperty['dataClass'] = 'text', masked = false): GraphProperty => ({ key, value, dataClass, masked });
const entity = (key: string, mapped: readonly string[] | undefined, properties: readonly GraphProperty[], extras: readonly Extra[] = []): CompareElement => ({ key, kind: 'entity', mapped, properties, extras });
const status = (a: GraphProperty | undefined, b: GraphProperty | undefined): string => statusOf([propertyCell(a), propertyCell(b)]);

describe('the cell of a property', () => {
  it('is a value, an empty text, an unavailable value or a masked value, and never one for another', () => {
    expect(propertyCell(prop('a', 'x'))).toMatchObject({ kind: 'value', text: 'x' });
    expect(propertyCell(prop('a', ''))).toMatchObject({ kind: 'empty', text: 'empty' });
    expect(propertyCell(prop('a', undefined, 'unknown'))).toMatchObject({ kind: 'unavailable', text: 'unavailable' });
    expect(propertyCell(prop('a', null))).toMatchObject({ kind: 'unavailable' });
    expect(propertyCell(undefined)).toMatchObject({ kind: 'unavailable' });
    expect(propertyCell(prop('a', 'J••• L•••', 'name', true))).toMatchObject({ kind: 'masked', text: 'J••• L•••' });
  });
});

describe('when two compared cells match', () => {
  it.each([
    ['the same instant in two offsets', prop('t', '2026-11-09T10:00:00+01:00', 'dateTime'), prop('t', '2026-11-09T09:00:00Z', 'dateTime'), 'same'],
    ['1 and 1.0', prop('n', 1, 'number'), prop('n', 1.0, 'number'), 'same'],
    ['text in another case', prop('s', 'A'), prop('s', 'a'), 'differs'],
    ['text with a space more', prop('s', 'a'), prop('s', 'a '), 'differs'],
    ['a value and an unavailable value', prop('s', 'a'), prop('s', undefined, 'unknown'), 'differs'],
    ['two unavailable values', prop('s', undefined, 'unknown'), prop('s', null), 'same'],
    ['an empty text and an unavailable value', prop('s', ''), prop('s', undefined, 'unknown'), 'differs'],
    ['the same text under two data classes', prop('s', '5', 'text'), prop('s', '5', 'number'), 'differs'],
    ['lists with the same members in one order', prop('l', ['a', 'b'], 'list'), prop('l', ['a', 'b'], 'list'), 'same'],
    ['lists in another order', prop('l', ['a', 'b'], 'list'), prop('l', ['b', 'a'], 'list'), 'differs'],
    ['objects with their keys in another order', prop('o', { a: 1, b: 2 }, 'other'), prop('o', { b: 2, a: 1 }, 'other'), 'same'],
  ])('%s', (_name, a, b, expected) => {
    expect(status(a, b)).toBe(expected);
  });
});

describe('a masked cell', () => {
  it('is never Same and never Differs by itself, even when two masks are the same text', () => {
    expect(status(prop('n', 'J•••', 'name', true), prop('n', 'J•••', 'name', true))).toBe('cannot');
    expect(status(prop('n', 'J•••', 'name', true), prop('n', 'K•••', 'name', true))).toBe('cannot');
  });

  it('leaves a row that matches among the others as Cannot compare, and one that differs among the others as Differs', () => {
    expect(statusOf([propertyCell(prop('s', 'a')), propertyCell(prop('s', 'a')), propertyCell(prop('s', 'M', 'text', true))])).toBe('cannot');
    expect(statusOf([propertyCell(prop('s', 'a')), propertyCell(prop('s', 'b')), propertyCell(prop('s', 'M', 'text', true))])).toBe('differs');
  });

  it('is marked on the row', () => {
    const [row] = buildRows([entity('a', ['n'], [prop('n', 'M', 'name', true)]), entity('b', ['n'], [prop('n', 'x')])]);
    expect(row).toMatchObject({ includesMasked: true, status: 'cannot' });
  });
});

describe('the rows of entities of different types', () => {
  const account = entity('a', ['id', 'balance'], [prop('id', 'A1'), prop('balance', 5, 'number')]);
  const customer = entity('c', ['id', 'band'], [prop('id', 'C1'), prop('band', 'retail')]);

  it('lists the keys of the first element first, then the keys the others add, one cell each', () => {
    const rows = buildRows([account, customer]);
    expect(rows.map((row) => row.label)).toEqual(['id', 'balance', 'band']);
    expect(rows[1]?.cells.map((cell) => cell.kind)).toEqual(['value', 'not-mapped']);
    expect(rows[2]?.cells.map((cell) => cell.kind)).toEqual(['not-mapped', 'value']);
  });

  it('reads "not mapped" differently from an empty value and an unavailable one, and does not make a row differ', () => {
    const rows = buildRows([account, entity('c', ['id', 'balance'], [prop('id', 'C1'), prop('balance', '')]), customer]);
    const balance = rows.find((row) => row.label === 'balance');
    expect(balance?.cells.map((cell) => cell.kind)).toEqual(['value', 'empty', 'not-mapped']);
    const alone = buildRows([account, customer]).find((row) => row.label === 'balance');
    expect(alone?.status).toBe('cannot');
  });

  it('calls a mapped property that the element lacks unavailable, not not mapped', () => {
    const rows = buildRows([account, entity('b', ['id', 'balance'], [prop('id', 'A2')])]);
    expect(rows.find((row) => row.label === 'balance')?.cells.map((cell) => cell.kind)).toEqual(['value', 'unavailable']);
    expect(rows.find((row) => row.label === 'balance')?.status).toBe('differs');
  });

  it('says that no property is mapped in common when none is', () => {
    const rows = buildRows([entity('a', ['x'], [prop('x', '1')]), entity('b', ['y'], [prop('y', '2')])]);
    expect(shareNoProperty(rows)).toBe(true);
    expect(shareNoProperty(buildRows([account, customer]))).toBe(false);
  });

  it('draws an element whose type the profile does not hold from the properties it carries, and calls none of them not mapped', () => {
    const rows = buildRows([account, entity('x', undefined, [prop('id', 'X1')])]);
    expect(rows.find((row) => row.label === 'balance')?.cells.map((cell) => cell.kind)).toEqual(['value', 'unavailable']);
  });
});

describe('the rows "differences only" leaves out', () => {
  const quiet = (...elements: CompareElement[]): boolean[] => buildRows(elements).map(isQuiet);
  const both = (key: string, value: unknown) => entity(key, ['x'], [prop('x', value)]);

  it('are the rows that are the same, and the rows where at most one element has a value', () => {
    expect(quiet(both('a', 'v'), both('b', 'v'))).toEqual([true]);
    expect(quiet(entity('a', ['x', 'y'], [prop('x', '1'), prop('y', '2')]), entity('b', ['x'], [prop('x', '1')]))).toEqual([true, true]);
    expect(quiet(entity('a', ['y'], [prop('y', '2')]), entity('b', ['x'], [prop('x', '1')]))).toEqual([true, true]);
  });

  it('keep a row that differs, and a row where a value is set against an unavailable one', () => {
    expect(quiet(both('a', '1'), both('b', '2'))).toEqual([false]);
    expect(quiet(both('a', '1'), both('b', undefined))).toEqual([false]);
  });

  it('never leave out a row with a masked cell, even when only that one element has a value', () => {
    const masked = entity('m', ['x'], [prop('x', 'J•••', 'name', true)]);
    expect(quiet(masked, entity('b', ['y'], [prop('y', '1')]))).toEqual([false, true]);
    expect(quiet(masked, both('b', 'v'))).toEqual([false]);
    expect(quiet(masked, masked)).toEqual([false]);
  });

  it('leave out a row where every cell is outside the comparison', () => {
    const aggregateOnly: CompareElement = { key: 'g', kind: 'aggregate', mapped: ['lane'], properties: [], extras: [] };
    expect(quiet(aggregateOnly, { ...aggregateOnly, key: 'h' })).toEqual([true]);
  });
});

describe('the kinds of relationship', () => {
  const stored = (key: string, observed: string | undefined): CompareElement => ({ key, kind: 'stored', mapped: ['lane'], properties: [prop('lane', 'web')], extras: observed === undefined ? [] : [{ id: 'observed', label: 'Observed', cell: propertyCell(prop('Observed', observed, 'dateTime')) }] });
  const aggregate = (key: string): CompareElement => ({ key, kind: 'aggregate', mapped: ['lane'], properties: [], extras: [{ id: 'members', label: 'Members', cell: { kind: 'value', text: '42 · exact', same: 'm|42|exact' } }] });
  const derived = (key: string, rule: string): CompareElement => ({ key, kind: 'derived', mapped: undefined, properties: [], extras: [{ id: 'rule', label: 'Rule', cell: { kind: 'value', text: rule, same: `r|${rule}` } }] });

  it('gives an aggregate no single value for a mapped property and a derived one none at all, and leaves both out of the comparison', () => {
    const rows = buildRows([stored('s', '2026-11-09T10:00:00Z'), aggregate('g'), derived('d', 'shared-device v1')]);
    expect(rows.find((row) => row.label === 'lane')?.cells.map((cell) => cell.kind)).toEqual(['value', 'varies', 'not-mapped']);
    expect(rows.find((row) => row.label === 'lane')?.status).toBe('cannot');
  });

  it('compares two derived relationships by the Rule row, and a derived one with a stored one cannot', () => {
    expect(buildRows([derived('a', 'shared-device v1'), derived('b', 'shared-device v1')]).find((row) => row.label === 'Rule')?.status).toBe('same');
    expect(buildRows([derived('a', 'shared-device v1'), derived('b', 'shared-address v1')]).find((row) => row.label === 'Rule')?.status).toBe('differs');
    expect(buildRows([derived('a', 'shared-device v1'), stored('s', undefined)]).find((row) => row.label === 'Rule')?.status).toBe('cannot');
  });

  it('compares an aggregate\'s range of times only with another aggregate\'s, never with a stored relationship\'s single time', () => {
    const range = (key: string, first: string, last: string): CompareElement => ({ ...aggregate(key), extras: [{ id: 'observed', label: 'Observed', cell: { kind: 'value', text: `${first} to ${last}`, same: `r|${first}|${last}`, family: 'range' } }] });
    const rowOf = (...elements: CompareElement[]) => buildRows(elements).find((row) => row.label === 'Observed');
    expect(rowOf(range('a', '1', '2'), stored('s', '2026-11-09T10:00:00Z'))?.status).toBe('cannot');
    expect(rowOf(range('a', '1', '2'), range('b', '1', '2'), stored('s', '2026-11-09T10:00:00Z'))?.status).toBe('same');
    expect(rowOf(range('a', '1', '2'), range('b', '1', '3'), stored('s', '2026-11-09T10:00:00Z'))?.status).toBe('differs');
  });

  it('reads Rule and Members as not mapped for a relationship that has no rule or no member count', () => {
    const rows = buildRows([derived('d', 'shared v1'), aggregate('g'), stored('s', undefined)]);
    expect(rows.find((row) => row.label === 'Rule')?.cells.map((cell) => cell.kind)).toEqual(['value', 'not-mapped', 'not-mapped']);
    expect(rows.find((row) => row.label === 'Members')?.cells.map((cell) => cell.kind)).toEqual(['not-mapped', 'value', 'not-mapped']);
  });

  it('shows Observed as not stated for an element that holds no time at all', () => {
    const rows = buildRows([stored('a', '2026-11-09T10:00:00Z'), stored('b', undefined)]);
    expect(rows.find((row) => row.label === 'Observed')?.cells.map((cell) => cell.kind)).toEqual(['value', 'not-stated']);
  });
});
