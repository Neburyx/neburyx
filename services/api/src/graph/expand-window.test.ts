import { describe, expect, it } from 'vitest';
import { expandWindowInstantsOf } from './expand-window.js';

const at = (iso: string) => new Date(iso);

describe('the window of an expansion', () => {
  it.each([
    ['2026-11-12T00:00:00.000Z', 7, '2026-11-05T00:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ['2026-11-12T00:30:00.000Z', 7, '2026-11-05T00:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ['2026-11-12T23:59:59.999Z', 7, '2026-11-05T00:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ['2026-11-13T00:00:00.000Z', 7, '2026-11-06T00:00:00.000Z', '2026-11-14T00:00:00.000Z'],
    ['2026-03-01T12:00:00.000Z', 1, '2026-02-28T00:00:00.000Z', '2026-03-02T00:00:00.000Z'],
    ['2028-03-01T12:00:00.000Z', 2, '2028-02-28T00:00:00.000Z', '2028-03-02T00:00:00.000Z'],
    ['2026-01-02T05:00:00.000Z', 3650, '2016-01-05T00:00:00.000Z', '2026-01-03T00:00:00.000Z'],
  ])('reads %s with %i days as whole UTC days: from %s up to %s', (now, days, from, to) => {
    expect(expandWindowInstantsOf({ days }, at(now))).toEqual({ windowFrom: from, windowTo: to });
  });

  it('holds at least the days asked, whatever the hour of the day', () => {
    for (const hour of [0, 1, 11, 23]) {
      const { windowFrom, windowTo } = expandWindowInstantsOf({ days: 7 }, at(`2026-11-12T${String(hour).padStart(2, '0')}:00:00.000Z`));
      expect(Date.parse(windowTo) - Date.parse(windowFrom)).toBeGreaterThanOrEqual(7 * 86_400_000);
    }
  });

  it('is the same for every instant of one UTC day, so that a cursor that binds it lives that long', () => {
    expect(expandWindowInstantsOf({ days: 30 }, at('2026-11-12T00:00:00.000Z'))).toEqual(expandWindowInstantsOf({ days: 30 }, at('2026-11-12T23:59:59.999Z')));
  });

  it('reads a range of dates as a template run does, the last day included', () => {
    expect(expandWindowInstantsOf({ from: '2024-02-28', to: '2024-02-29' }, at('2026-11-12T00:00:00.000Z'))).toEqual({ windowFrom: '2024-02-28T00:00:00.000Z', windowTo: '2024-03-01T00:00:00.000Z' });
  });
});
