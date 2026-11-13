import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, MAX_WINDOW_DAYS, readDays, windowKey, windowRequestOf } from './expand-window.js';

describe('the window of an expansion', () => {
  it('is the last 7 days by default', () => {
    expect(DEFAULT_WINDOW).toEqual({ days: 7 });
  });

  it('is sent as the number of days, and as nothing for all time', () => {
    expect(windowRequestOf({ days: 30 })).toEqual({ window: { days: 30 } });
    expect(windowRequestOf('all')).toEqual({});
  });

  it('has a key for each window, so that two windows are the same ask exactly when their keys are equal', () => {
    expect(windowKey({ days: 7 })).toBe(windowKey({ days: 7 }));
    expect(new Set([windowKey({ days: 7 }), windowKey({ days: 30 }), windowKey('all')]).size).toBe(3);
  });

  it.each([['1', 1], ['7', 7], [' 30 ', 30], [String(MAX_WINDOW_DAYS), MAX_WINDOW_DAYS]])('reads %j as %i days', (text, days) => {
    expect(readDays(text)).toEqual({ ok: true, days });
  });

  it.each(['', '0', '-3', '1.5', '1e3', 'seven', String(MAX_WINDOW_DAYS + 1), '３０', '7 days'])('refuses %j and says what to enter', (text) => {
    const read = readDays(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('Enter a whole number of days from 1 to 3650.');
  });
});
