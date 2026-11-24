import { pluralOf } from '@neburyx/contracts';
import { createCheckRunner, removalNoteOf } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';
import { judgeCheck } from '../case-summary/judge.js';
import { judgeTableRows, labelWordsOf, labelsHold, parseTable, rowSentenceOf } from './table.js';

const VIEW_TEXT = [
  'Entities:',
  'n1 | "figure" | title: "Figure T-1" | id: "T-1" | codeUsd: 4200; status: "open"',
  'n2 | "lane" | title: "Lane C-1" | id: "C-1" | riskRating: "low"',
  'Relationships:',
  'e1 | "SENT" | n2 -> n1 | stored',
].join('\n');
const RESULT_TEXT = 'r1: tier: Tier A-1 | openedOn: "2020-01-02"\ns1: read of byAccount: 1 shown · exact';

describe('the reading of a table reply', () => {
  const ok = { columns: ['Element', 'Type'], rows: [{ cells: ['Account A-1', 'widget'], cites: ['n1'] }] };

  it('reads the exact shape, with every row held and the cells of a row in the order of the columns', () => {
    expect(parseTable(ok)).toEqual({ ...ok, uncited: 0 });
  });

  it.each([
    ['another member', { ...ok, title: 'x' }],
    ['no column', { ...ok, columns: [] }],
    ['seven columns', { columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows: [{ cells: ['1', '2', '3', '4', '5', '6', '7'], cites: ['n1'] }] }],
    ['a blank label', { ...ok, columns: ['Element', ' '] }],
    ['a label over 40', { ...ok, columns: ['L'.repeat(41), 'Type'] }],
    ['a cell over 80', { ...ok, rows: [{ cells: ['C'.repeat(81), 'x'], cites: ['n1'] }] }],
    ['a control character', { ...ok, rows: [{ cells: ['a\u0007b', 'x'], cites: ['n1'] }] }],
    ['a short row', { ...ok, rows: [{ cells: ['x'], cites: ['n1'] }] }],
    ['a row with another member', { ...ok, rows: [{ cells: ['a', 'b'], cites: ['n1'], extra: 1 }] }],
    ['an empty cite', { ...ok, rows: [{ cells: ['a', 'b'], cites: [''] }] }],
    ['no row', { ...ok, rows: [] }],
    ['101 rows', { ...ok, rows: Array.from({ length: 101 }, () => ({ cells: ['a', 'b'], cites: ['n1'] })) }],
  ])('refuses %s', (_name, value) => {
    expect(parseTable(value)).toBeUndefined();
  });

  it('counts the bounds in UTF-16 units as the contract does, so that a cell that passes also passes the response schema', () => {
    const cell = (count: number) => ({ ...ok, rows: [{ cells: ['😀'.repeat(count), 'x'], cites: ['n1'] }] });
    expect(parseTable(cell(40))).toBeDefined();
    expect(parseTable(cell(41))).toBeUndefined();
    expect(parseTable({ ...ok, columns: ['😀'.repeat(20), 'Type'] })).toBeDefined();
    expect(parseTable({ ...ok, columns: ['😀'.repeat(21), 'Type'] })).toBeUndefined();
  });

  it('drops a row that cites nothing and counts it, and keeps every other row', () => {
    const draft = parseTable({ columns: ['Element', 'Type'], rows: [{ cells: ['a', 'b'], cites: ['n1'] }, { cells: ['c', 'd'], cites: [] }, { cells: ['e', 'f'], cites: ['n2'] }] });
    expect(draft?.rows.map((row) => row.cells[0])).toEqual(['a', 'e']);
    expect(draft?.uncited).toBe(1);
  });

  it('reads a row as one sentence of its cells, without the labels', () => {
    expect(rowSentenceOf({ cells: ['Account A-1', '', 'open'], cites: ['n1'] })).toEqual({ text: 'Account A-1; open', cites: ['n1'] });
  });

  it('writes the plural of a label by a fixed rule', () => {
    expect(['Widget', 'Company', 'Gadget', 'Box', 'Match', 'Wish', 'Day'].map(pluralOf)).toEqual(['Widgets', 'Companies', 'Gadgets', 'Boxes', 'Matches', 'Wishes', 'Days']);
  });
});

describe('the judging of column labels', () => {
  it('takes the words of the property keys and of the types of the text sent', () => {
    const words = labelWordsOf(VIEW_TEXT);
    for (const word of ['figure', 'lane', 'code', 'usd', 'status', 'risk', 'rating', 'title', 'id']) expect(words.has(word), word).toBe(true);
    for (const word of ['retail', 'low', 'open']) expect(words.has(word), word).toBe(false);
    expect([...labelWordsOf(RESULT_TEXT)]).toEqual(expect.arrayContaining(['tier', 'opened', 'on']));
  });

  it('keeps labels of plain words that the text or the fixed list backs, in singular or plural', () => {
    expect(labelsHold(['Element', 'Type', 'Date', 'Direction', 'Cite'], VIEW_TEXT)).toBe(true);
    expect(labelsHold(['Figure', 'Code', 'Risk rating', 'Lanes'], VIEW_TEXT)).toBe(true);
  });

  it('fails a label with a word nothing backs, a number, a verdict word, a symbol or a key that was not sent', () => {
    for (const label of ['Suspicion level', 'Fraud flag', 'Score 7', 'Code (USD)', 'Total', 'Rank', 'Sum', 'Email', '12', 'codeEur']) expect(labelsHold(['Element', label], VIEW_TEXT), label).toBe(false);
  });
});

describe('the rows of a table judged against the count of the cited elements', () => {
  const line = (key: string, title: string): string => `${key} | "figure" | title: "${title}" | id: "${key}x"`;
  const text = {
    text: [line('n1', 'Figure A'), line('n2', 'Figure B')].join('\n'),
    keys: new Map([['n1', true], ['n2', true]]),
    lines: new Map([['n1', line('n1', 'Figure A')], ['n2', line('n2', 'Figure B')]]),
    inexactCounts: [],
    unknownCountKeys: new Set<string>(),
    elementTypes: new Map([['n1', 'entity figure'], ['n2', 'entity figure']]),
  };
  const judge = (row: { text: string; cites: string[] }, columns?: string[], drop = false) => judgeTableRows({ rows: [row], columns, checks: createCheckRunner({ thresholdMs: 60000 }), judge: judgeCheck, text, timeoutMs: 5000, signal: new AbortController().signal, drop: () => drop });

  it('removes a row whose cell holds a number no cited line holds, though it equals the number of cited elements', async () => {
    const judged = await judge({ text: '2 figures', cites: ['n1', 'n2'] });
    expect(judged).toMatchObject({ kept: [], removed: 1 });
  });

  it('keeps a row whose cells hold the cited line values', async () => {
    const judged = await judge({ text: 'Figure A', cites: ['n1'] });
    expect(judged).toMatchObject({ removed: 0, positions: [0] });
  });

  it.each([
    ['a number no cited line holds', { text: '2 figures', cites: ['n1', 'n2'] }, undefined, false, 'cell'],
    ['a key written in a cell', { text: 'Figure A (n1)', cites: ['n1'] }, undefined, false, 'key'],
    ['a citation the answer may not rest on', { text: 'Figure A', cites: ['n1'] }, undefined, true, 'row'],
    ['a column label no word of the text sent backs', { text: 'Figure A', cites: ['n1'] }, ['Suspicion level'], false, 'label'],
  ] as const)('gives one reason for the row removed for %s', async (_cause, row, columns, drop, reason) => {
    const judged = await judge({ text: row.text, cites: [...row.cites] }, columns === undefined ? undefined : [...columns], drop);
    expect(judged).toMatchObject({ kept: [], removed: 1, rejected: [{ text: row.text, reason }] });
    if ('rejected' in judged) {
      expect(judged.rejected).toHaveLength(judged.removed);
      if (reason === 'cell') expect(removalNoteOf(judged.rejected)).toContain('in a table');
      if (reason === 'row') expect(removalNoteOf(judged.rejected)).toContain('a row may not rest on');
    }
  });
});
