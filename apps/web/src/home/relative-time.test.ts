import { describe, expect, it } from 'vitest';
import { relativeTime, utcClock, utcMoment } from './relative-time.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const before = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relative time', () => {
  it.each([
    [0, 'just now'],
    [59 * SECOND, 'just now'],
    [60 * SECOND, '1 min ago'],
    [12 * MINUTE + 30 * SECOND, '12 min ago'],
    [59 * MINUTE + 59 * SECOND, '59 min ago'],
    [HOUR, '1 h ago'],
    [23 * HOUR + 59 * MINUTE, '23 h ago'],
    [DAY, '1 day ago'],
    [2 * DAY + HOUR, '2 days ago'],
    [400 * DAY, '400 days ago'],
    [-5 * MINUTE, 'just now'],
  ])('reads %i ms as %s', (elapsed, text) => {
    expect(relativeTime(before(elapsed), NOW)).toBe(text);
  });

  it('writes a time in UTC', () => {
    expect(utcClock('2026-11-05T09:42:10.000Z')).toBe('09:42');
    expect(utcMoment('2026-11-05T09:42:10.000Z')).toBe('2026-11-05 09:42 UTC');
  });
});
