import { describe, expect, it } from 'vitest';
import { firstAndLast } from './observed.js';

const zoned = (value: string) => ({ $type: 'dateTime', value });
const local = (value: string) => ({ $type: 'localDateTime', value });
const day = (value: string) => ({ $type: 'date', value });

describe('the first and last time of the members of an aggregate', () => {
  it('compares zoned times as instants, so a later local clock time in an earlier offset is the earlier instant, and writes each as the member gave it', () => {
    const result = firstAndLast([zoned('2026-01-02T10:00:00+02:00'), zoned('2026-01-02T09:30:00Z'), zoned('2026-01-02T08:00:00-05:00')]);
    expect(result).toEqual({ first: '2026-01-02T10:00:00+02:00', last: '2026-01-02T08:00:00-05:00', mixed: false });
  });

  it('keeps the sub-second digits, so two times in one millisecond are told apart', () => {
    const result = firstAndLast([zoned('2026-01-02T03:04:05.123456789Z'), zoned('2026-01-02T03:04:05.123456788Z')]);
    expect(result).toMatchObject({ first: '2026-01-02T03:04:05.123456788Z', last: '2026-01-02T03:04:05.123456789Z' });
  });

  it('ignores a zone id after the offset', () => {
    expect(firstAndLast([zoned('2026-01-02T03:04:05+01:00[Europe/Paris]')])).toMatchObject({ first: '2026-01-02T03:04:05+01:00[Europe/Paris]' });
  });

  it('compares local times and dates among themselves with no zone added, a date as the start of its day', () => {
    const result = firstAndLast([local('2026-01-03T10:00:00'), day('2026-01-03'), local('2026-01-02T23:59:59.5'), day('2026-01-04')]);
    expect(result).toEqual({ first: '2026-01-02T23:59:59.5', last: '2026-01-04', mixed: false });
  });

  it('uses the zoned members and says so when zoned and local times are mixed', () => {
    const result = firstAndLast([local('2020-01-01T00:00:00'), zoned('2026-01-02T03:04:05Z'), zoned('2026-01-01T03:04:05Z')]);
    expect(result).toEqual({ first: '2026-01-01T03:04:05Z', last: '2026-01-02T03:04:05Z', mixed: true });
  });

  it.each([
    ['text', 'yesterday'],
    ['a time of day', { $type: 'time', value: '10:00:00Z' }],
    ['a local time of day', { $type: 'localTime', value: '10:00:00' }],
    ['a duration', { $type: 'duration', value: 'P1D' }],
    ['a number', 5],
    ['nothing', undefined],
    ['null', null],
    ['a dateTime whose text is not ISO', zoned('last tuesday')],
  ])('ignores %s, and gives no first and last when nothing else is comparable', (_name, value) => {
    expect(firstAndLast([value])).toEqual({ mixed: false });
  });

  it('skips the members it cannot read and uses the rest', () => {
    expect(firstAndLast(['x', zoned('2026-01-02T00:00:00Z'), undefined])).toEqual({ first: '2026-01-02T00:00:00Z', last: '2026-01-02T00:00:00Z', mixed: false });
  });

  it('gives nothing for no members', () => {
    expect(firstAndLast([])).toEqual({ mixed: false });
  });
});
