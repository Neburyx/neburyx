import { describe, expect, it } from 'vitest';
import { labelWordsOf, labelsHold, parseTable, pluralOf, rowSentenceOf } from './table.js';

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
    expect(parseTable(ok)).toEqual(ok);
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
