import { describe, expect, it } from 'vitest';
import { groupChats, groupOf, type ChatGroup } from './chat-groups.js';

const at = (iso: string) => ({ lastQuestionAt: iso });

describe('the group of a chat by the date of its last question', () => {
  it('moves a chat from Today to Previous 7 days at midnight of the browser’s day', () => {
    const chat = '2026-11-22T23:59:58Z';
    expect(groupOf(chat, new Date('2026-11-22T23:59:59Z'), 'UTC')).toBe('today');
    expect(groupOf(chat, new Date('2026-11-23T00:00:01Z'), 'UTC')).toBe('previous7');
    expect(groupOf('2026-11-23T00:00:00Z', new Date('2026-11-23T00:00:01Z'), 'UTC')).toBe('today');
  });

  it('holds the seven calendar days before today in Previous 7 days and the eighth in Older, on a Monday', () => {
    const monday = new Date('2026-11-23T12:00:00Z');
    expect(monday.getUTCDay()).toBe(1);
    const group = (daysBefore: number): ChatGroup => groupOf(new Date(monday.getTime() - daysBefore * 86_400_000).toISOString(), monday, 'UTC');
    expect([group(0), group(1), group(7), group(8), group(30)]).toEqual(['today', 'previous7', 'previous7', 'older', 'older']);
    expect(groupOf('2026-11-16T00:00:00Z', monday, 'UTC')).toBe('previous7');
    expect(groupOf('2026-11-15T23:59:59Z', monday, 'UTC')).toBe('older');
  });

  it('takes the calendar day of the time zone, not of UTC', () => {
    const now = new Date('2026-11-23T10:30:00Z');
    expect(groupOf('2026-11-22T23:30:00Z', now, 'UTC')).toBe('previous7');
    expect(groupOf('2026-11-22T23:30:00Z', now, 'Pacific/Auckland')).toBe('today');
    expect(groupOf('2026-11-22T23:30:00Z', now, 'America/New_York')).toBe('previous7');
    expect(groupOf('2026-11-23T03:00:00Z', now, 'America/New_York')).toBe('previous7');
    expect(groupOf('2026-11-23T06:00:00Z', now, 'America/New_York')).toBe('today');
    expect(groupOf('2026-11-23T03:00:00Z', new Date('2026-11-24T06:00:00Z'), 'America/New_York')).toBe('previous7');
  });

  it('moves no chat by a day over the end of daylight saving, a day of 25 hours (2026-11-01 in America/New_York)', () => {
    const zone = 'America/New_York';
    const now = new Date('2026-11-02T10:00:00Z');
    expect(groupOf('2026-11-01T04:30:00Z', now, zone)).toBe('previous7');
    expect(groupOf('2026-11-01T05:30:00Z', new Date('2026-11-01T06:30:00Z'), zone)).toBe('today');
    expect(groupOf('2026-11-01T04:00:00Z', new Date('2026-11-01T23:00:00Z'), zone)).toBe('today');
    expect(groupOf('2026-10-31T23:59:00Z', new Date('2026-11-08T12:00:00Z'), zone)).toBe('older');
    expect(groupOf('2026-11-01T05:00:00Z', new Date('2026-11-08T12:00:00Z'), zone)).toBe('previous7');
  });

  it('puts a chat dated in the future, from a clock that is behind, in Today', () => {
    expect(groupOf('2026-11-25T08:00:00Z', new Date('2026-11-23T08:00:00Z'), 'UTC')).toBe('today');
  });
});

describe('the grouping of the chats of a list', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('keeps the order the chats came in within each group, draws only the groups that hold a chat, and keeps the groups in their order', () => {
    const rows = [at('2026-11-23T09:00:00Z'), at('2026-11-10T09:00:00Z'), at('2026-11-23T08:00:00Z'), at('2026-11-20T09:00:00Z')];
    expect(groupChats(rows, now, 'UTC').map((grouped) => [grouped.group, grouped.rows.map((row) => row.lastQuestionAt)])).toEqual([
      ['today', ['2026-11-23T09:00:00Z', '2026-11-23T08:00:00Z']],
      ['previous7', ['2026-11-20T09:00:00Z']],
      ['older', ['2026-11-10T09:00:00Z']],
    ]);
    expect(groupChats([at('2026-11-10T09:00:00Z')], now, 'UTC').map((grouped) => grouped.group)).toEqual(['older']);
    expect(groupChats([], now, 'UTC')).toEqual([]);
  });

  it('groups by the zone of the browser when none is given', () => {
    expect(groupChats([at(now.toISOString())], now)).toEqual([{ group: 'today', rows: [at(now.toISOString())] }]);
  });
});
