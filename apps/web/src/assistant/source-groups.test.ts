import { describe, expect, it } from 'vitest';
import type { CitationEnd, CitationEntry } from '../summary/summary-model.js';
import { groupSources, numberRanges } from './source-groups.js';

const end = (key: string, type: string): CitationEnd => ({ key, type, typeName: `Name of ${type}`, title: `Title ${key}` });
const entryOf = (number: number, type: string, from: CitationEnd | undefined, to: CitationEnd | undefined): CitationEntry => ({
  key: `k${number}`,
  number,
  kind: 'relationship',
  graphKey: `g${number}`,
  label: `label ${number}`,
  ...(from === undefined || to === undefined ? {} : { shape: { relationshipType: type, from, to } }),
});
const ACCOUNT = end('acc-1', 'Kind A');
const into = (number: number, type = 'RECEIVED_BY') => entryOf(number, type, end(`tx-${number}`, 'Kind B'), ACCOUNT);

describe('numberRanges', () => {
  it.each([
    [[3, 4, 5], '3–5'],
    [[3, 4, 5, 9], '3–5, 9'],
    [[9, 3, 5, 4], '3–5, 9'],
    [[7], '7'],
  ])('writes %j as %s', (numbers, text) => {
    expect(numberRanges(numbers)).toBe(text);
  });
});

describe('groupSources', () => {
  it('gathers rows of one relationship type and one type at the from end with the same element at the to end, at the place of the first', () => {
    const rows = groupSources([entryOf(1, 'OWNS', ACCOUNT, end('cu-1', 'Kind C')), ...[2, 3, 4].map((n) => into(n))]);
    expect(rows.map((row) => row.kind)).toEqual(['single', 'group']);
    const group = rows[1];
    expect(group?.kind === 'group' && group.text).toBe('3 Name of Kind B → Title acc-1 · RECEIVED_BY');
    expect(group?.kind === 'group' && group.numbers).toBe('2–4');
  });

  it('gathers the mirror: the same element at the from end and the same type at the to end, direction kept', () => {
    const rows = groupSources([2, 3].map((n) => entryOf(n, 'SENT', ACCOUNT, end(`tx-${n}`, 'Kind B'))));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === 'group' && rows[0].text).toBe('2 Title acc-1 → Name of Kind B · SENT');
    expect(groupSources([into(1), entryOf(2, 'RECEIVED_BY', ACCOUNT, end('tx-2', 'Kind B'))]).map((row) => row.kind)).toEqual(['single', 'single']);
  });

  it('says which numbers belong when another shape sits between, and never a range that includes a stranger', () => {
    const rows = groupSources([into(3), into(4), entryOf(5, 'OWNS', ACCOUNT, end('cu-1', 'Kind C')), into(6)]);
    expect(rows.map((row) => row.kind)).toEqual(['group', 'single']);
    expect(rows[0]?.kind === 'group' && rows[0].numbers).toBe('3–4, 6');
  });

  it('leaves a single row single, and a row with no known shape single', () => {
    const rows = groupSources([into(1), entryOf(2, 'RECEIVED_BY', undefined, undefined), entryOf(3, 'RECEIVED_BY', undefined, undefined)]);
    expect(rows.every((row) => row.kind === 'single')).toBe(true);
  });

  it('puts a row in one group only: the shape that holds the most rows wins', () => {
    const hub = end('hub', 'Kind A');
    const rows = groupSources([...[1, 2, 3].map((n) => entryOf(n, 'T', end(`x${n}`, 'Kind A'), hub)), entryOf(4, 'T', hub, end('z', 'Kind A'))]);
    expect(rows.map((row) => row.kind)).toEqual(['group', 'single']);
    expect(rows[0]?.kind === 'group' && rows[0].members.map((member) => member.number)).toEqual([1, 2, 3]);
  });
});
