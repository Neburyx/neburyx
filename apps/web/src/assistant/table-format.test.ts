import { describe, expect, it } from 'vitest';
import { cellOf, columnKinds, groupedNumber, headerOf, instantOf } from './table-format.js';

const rows = (...cells: string[][]) => cells.map((row) => ({ cells: row }));

describe('the figures of a table', () => {
  it('gives a decimal number its thousands separators and leaves every other number as read', () => {
    expect(groupedNumber('1664.72')).toBe('1,664.72');
    expect(groupedNumber('1234567.5')).toBe('1,234,567.5');
    expect(groupedNumber('-2450.10')).toBe('-2,450.10');
    expect(groupedNumber('203.6')).toBe('203.6');
    expect(groupedNumber('1,664.72')).toBe('1,664.72');
    expect(groupedNumber('2024')).toBe('2024');
    expect(groupedNumber('004856714')).toBe('004856714');
    expect(groupedNumber('0.5')).toBe('0.5');
    expect(groupedNumber('12 kg')).toBe('12 kg');
  });

  it('never changes the decimal places', () => {
    expect(groupedNumber('1500.5')).toBe('1,500.5');
    expect(groupedNumber('1500.500')).toBe('1,500.500');
  });
});

describe('the time stamps of a table', () => {
  it('writes an instant as date and time, and says UTC in the header only when every cell says it', () => {
    expect(instantOf('2022-09-09T22:33:00Z')).toEqual({ text: '2022-09-09 22:33:00', utc: true });
    expect(instantOf('2022-09-09 22:33:00.250+00:00')).toEqual({ text: '2022-09-09 22:33:00', utc: true });
    expect(instantOf('2022-09-09T22:33:00')).toEqual({ text: '2022-09-09 22:33:00', utc: false });
    expect(instantOf('2022-09-09')).toBeUndefined();
    const utc = rows(['2022-09-09T22:33:00Z'], ['2022-09-10T01:02:03Z']);
    expect(headerOf('Date', 'stamp', utc, 0)).toBe('Date (UTC)');
    expect(headerOf('Timestamp (UTC)', 'stamp', utc, 0)).toBe('Timestamp (UTC)');
    expect(headerOf('Date', 'stamp', rows(['2022-09-09T22:33:00Z'], ['2022-09-10T01:02:03']), 0)).toBe('Date');
    expect(headerOf('Opened', 'stamp', rows(['2022-09-09'], ['2022-09-10']), 0)).toBe('Opened');
    expect(headerOf('Size', 'number', rows(['1']), 0)).toBe('Size');
  });

  it('shows a date as it is and an instant as date and time', () => {
    expect(cellOf('2022-09-09', 'stamp')).toBe('2022-09-09');
    expect(cellOf('2022-09-09T22:33:00Z', 'stamp')).toBe('2022-09-09 22:33:00');
    expect(cellOf('Cash', 'text')).toBe('Cash');
  });
});

describe('the kind of a column', () => {
  it('is a kind only when every cell is of it', () => {
    const table = rows(['A-1', '1664.72', '2022-09-09T22:33:00Z', '2022-09-09'], ['A-2', 'n/a', '2022-09-10T01:02:03Z', '2022-09-10']);
    expect(columnKinds(['a', 'b', 'c', 'd'], table)).toEqual(['text', 'text', 'stamp', 'stamp']);
    expect(columnKinds(['a'], rows(['1'], ['2.5']))).toEqual(['number']);
    expect(columnKinds(['a'], [])).toEqual(['text']);
  });
});
