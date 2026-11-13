import { describe, expect, it } from 'vitest';
import { rebuildWithWords } from './rebuild.js';

const COMMON = ['in', 'the', 'since', 'show', 'me', 'day'];

function run(text: string) {
  return rebuildWithWords({ text, spans: [], vocabulary: [] }, COMMON);
}

const blockedTexts = (text: string): readonly string[] => {
  const result = run(text);
  return result.kind === 'blocked' ? result.tokens.map((token) => token.text) : [];
};

describe('a time-window phrase or a date', () => {
  it('blocks a count of four digits, a malformed unit and a unit that stands alone', () => {
    expect(blockedTexts('last 1000 days')).toEqual(['1000']);
    expect(blockedTexts('last 30 dayz')).toEqual(['last', 'dayz']);
    expect(blockedTexts('weeks')).toEqual(['weeks']);
    expect(blockedTexts('last')).toEqual(['last']);
    expect(blockedTexts('this weeks')).toEqual(['this', 'weeks']);
    expect(blockedTexts('last 30, days')).toEqual(['last', 'days']);
  });

  it('blocks Day when the list lacks it', () => {
    expect(rebuildWithWords({ text: 'show me Day', spans: [], vocabulary: [] }, ['show', 'me'])).toEqual({ kind: 'blocked', tokens: [{ text: 'Day', start: 8, end: 11 }] });
  });

  it('keeps a word that is on the list as the word it is, even when it is also a unit', () => {
    expect(run('show me day')).toEqual({ kind: 'rebuilt', text: 'show me day' });
  });

  it('blocks a date that is not a real calendar date in range, and a bare year', () => {
    for (const date of ['2023-02-29', '2024-13-01', '2024-1-5', '24-02-29', '1899-12-31', '2101-01-01', '2024-00-10', '2024-04-31']) expect(blockedTexts(date)).toEqual([date]);
    expect(blockedTexts('2024')).toEqual(['2024']);
  });

  it('rebuilds the phrases of the grammar exactly', () => {
    for (const text of ['last 30 days', 'in the last 90 days', 'past 2 weeks', 'previous year', 'this month', 'today', 'yesterday', 'show me the last day']) {
      expect(run(text)).toEqual({ kind: 'rebuilt', text });
    }
  });

  it('allows a real date and a date followed by a mark', () => {
    expect(run('2024-02-29')).toEqual({ kind: 'rebuilt', text: '2024-02-29' });
    expect(run('1900-01-01')).toEqual({ kind: 'rebuilt', text: '1900-01-01' });
    expect(run('since 2024-02-29.')).toEqual({ kind: 'rebuilt', text: 'since 2024-02-29.' });
  });
});
