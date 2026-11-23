import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AssistantTable, TypeDescriptions } from '@neburyx/contracts';
import { noteOfTable, parseBlocksInput, withinTotals, type KeptBlock } from './blocks.js';

const LINES = new Map([
  ['n1', 'n1 | "payment" | title: "Payment P-1" | sizeUsd: 4200; feeUsd: 12; weight: 4200; status: "open"'],
  ['n2', 'n2 | "payment" | sizeUsd: 80; status: "closed"'],
]);
const ELEMENTS = new Map([
  ['n1', { ref: { entityType: 'payment' } }],
  ['n2', { ref: { entityType: 'payment' } }],
]);
const describe_ = (display: Record<string, { label?: string; unit?: string }>): TypeDescriptions => ({ entityTypes: [{ type: 'payment', label: 'Payment', displayName: 'Payment', propertyDisplay: display }], relationshipTypes: [] });
const note = (columns: string[], rows: { cells: string[]; cites: string[] }[], display: Record<string, { label?: string; unit?: string }> | undefined) =>
  noteOfTable({ columns, rows, lines: LINES, elements: ELEMENTS, descriptions: display === undefined ? undefined : describe_(display) });
const SELECT = 'Each row selects its elements on the graph.';

describe('the note of a table block', () => {
  it('is the fixed sentence alone when no column shows a value with a unit', () => {
    expect(note(['Status'], [{ cells: ['open'], cites: ['n1'] }], { sizeUsd: { label: 'size', unit: 'USD' } })).toBe(SELECT);
    expect(note(['Size'], [{ cells: ['4200'], cites: ['n1'] }], undefined)).toBe(SELECT);
  });

  it('writes a clause from the mapping for a column whose cell shows the value of a property with a unit', () => {
    expect(note(['Size'], [{ cells: ['4,200'], cites: ['n1'] }], { sizeUsd: { label: 'size', unit: 'USD' } })).toBe(`Size in USD. ${SELECT}`);
  });

  it('writes one clause for each column, and none twice when two columns share a unit and a label', () => {
    const display = { sizeUsd: { label: 'size', unit: 'USD' }, feeUsd: { label: 'fee', unit: 'USD' } };
    expect(note(['Size', 'Fee'], [{ cells: ['4200', '12'], cites: ['n1'] }], display)).toBe(`Size in USD. Fee in USD. ${SELECT}`);
    expect(note(['A', 'B'], [{ cells: ['4200', '4200'], cites: ['n1'] }], { sizeUsd: { label: 'size', unit: 'USD' } })).toBe(`Size in USD. ${SELECT}`);
  });

  it('takes the first matching property of a column that two properties could match, in the order of the line', () => {
    const display = { sizeUsd: { label: 'size', unit: 'USD' }, weight: { label: 'weight', unit: 'kg' } };
    expect(note(['Value'], [{ cells: ['4200'], cites: ['n1'] }], display)).toBe(`Size in USD. ${SELECT}`);
  });

  it('gives two units when two columns show values in two units', () => {
    const display = { feeUsd: { label: 'fee', unit: 'USD' }, weight: { label: 'weight', unit: 'kg' } };
    expect(note(['Fee', 'Weight'], [{ cells: ['12', '4200'], cites: ['n1'] }], display)).toBe(`Fee in USD. Weight in kg. ${SELECT}`);
  });
});

describe('the note of a table block for a second pack', () => {
  it('writes the same clauses from the display of another pack, with no change of code', () => {
    // the first entity type and its label are read from the second pack's own mapping
    const mapping = readFileSync(fileURLToPath(new URL('../../../../domain-packs/insurance-claims/neburyx.yaml', import.meta.url)), 'utf8');
    const type = /^\s+- type: (\S+)$/m.exec(mapping)?.[1] ?? '';
    const label = /^\s+label: (\S+)$/m.exec(mapping)?.[1] ?? '';
    expect(type).not.toBe('');
    const lines = new Map([['c1', `c1 | "${type}" | title: "${label} 1" | reserveEur: 1500; status: "open"`]]);
    const elements = new Map([['c1', { ref: { entityType: type } }]]);
    const descriptions: TypeDescriptions = { entityTypes: [{ type, label, displayName: label, propertyDisplay: { reserveEur: { label: 'reserve', unit: 'EUR' } } }], relationshipTypes: [] };
    expect(noteOfTable({ columns: [label, 'Reserve'], rows: [{ cells: [`${label} 1`, '1,500'], cites: ['c1'] }], lines, elements, descriptions })).toBe(`Reserve in EUR. ${SELECT}`);
  });
});

const input = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, ...extra });
const SENT = { sentences: [{ text: 'A.', cites: ['n1'] }] };
const TAB = { columns: ['Element'], rows: [{ cells: ['a'], cites: ['n1'] }] };

describe('the blocks of the answer tool', () => {
  it('reads one to four blocks of the exact shape', () => {
    expect(parseBlocksInput([input('sentences', SENT), input('table', TAB)], true)).toHaveLength(2);
    expect(parseBlocksInput([], true)).toBeUndefined();
    expect(parseBlocksInput(Array.from({ length: 5 }, () => input('sentences', SENT)), true)).toBeUndefined();
  });

  it('refuses a table block when no table was asked for, another member, and another kind', () => {
    expect(parseBlocksInput([input('table', TAB)], false)).toBeUndefined();
    expect(parseBlocksInput([input('sentences', { ...SENT, title: 'x' })], true)).toBeUndefined();
    expect(parseBlocksInput([input('table', { ...TAB, title: 'x' })], true)).toBeUndefined();
    expect(parseBlocksInput([input('chart', TAB)], true)).toBeUndefined();
  });
});

const tableOf = (rows: number, moreNotShown?: number): KeptBlock => ({ kind: 'table', table: { title: 't', columns: ['E'], note: 'n', rows: Array.from({ length: rows }, () => ({ cells: ['a'], cites: ['n1'] })), ...(moreNotShown === undefined ? {} : { moreNotShown }) } as AssistantTable });
const sentencesOf = (count: number): KeptBlock => ({ kind: 'sentences', sentences: Array.from({ length: count }, () => ({ text: 'A.', cites: ['n1'] })) });

describe('the list blocks of the answer tool', () => {
  it('reads a list of the exact shape, with or without a label, and refuses any other', () => {
    const items = [{ text: 'A.', cites: ['n1'] }];
    expect(parseBlocksInput([{ kind: 'list', items }], false)).toEqual([{ kind: 'list', items }]);
    expect(parseBlocksInput([{ kind: 'list', label: 'Details', items }], false)).toEqual([{ kind: 'list', label: 'Details', items }]);
    for (const bad of [{ kind: 'list', items: [] }, { kind: 'list', label: '', items }, { kind: 'list', label: 'x'.repeat(41), items }, { kind: 'list', items, extra: 1 }, { kind: 'list', items: [{ text: 'A.', cites: ['n1'], extra: 1 }] }, { kind: 'list', items: Array.from({ length: 13 }, () => items[0]) }, { kind: 'list', label: 1, items }]) expect(parseBlocksInput([bad], false)).toBeUndefined();
  });

  it('counts the items of lists with the sentences toward 12 and reports the items it cut', () => {
    const many = (count: number) => Array.from({ length: count }, () => ({ text: 'A.', cites: ['n1'] }));
    const totalled = withinTotals([{ kind: 'sentences', sentences: many(5) }, { kind: 'list', label: 'L', items: many(10) }, { kind: 'list', items: many(1) }]);
    expect(totalled.blocks.map((block) => (block.kind === 'list' ? block.items.length : block.kind === 'sentences' ? block.sentences.length : 0))).toEqual([5, 7]);
    expect(totalled.itemsCut).toBe(4);
    expect(totalled.leftOut).toBe(0);
  });
});

describe('the totals of the blocks', () => {
  it('cuts rows beyond 25 from the later tables and adds them to the count of the table they were cut from', () => {
    const { blocks } = withinTotals([tableOf(20), tableOf(10, 4)]);
    const second = blocks[1];
    expect(second?.kind === 'table' && second.table.rows.length).toBe(5);
    expect(second?.kind === 'table' && second.table.moreNotShown).toBe(9);
  });

  it('leaves out a table with no row left and counts the block as left out', () => {
    const { blocks, leftOut } = withinTotals([tableOf(25), tableOf(3)]);
    expect(blocks).toHaveLength(1);
    expect(leftOut).toBe(1);
  });

  it('cuts sentences beyond 12 from the end', () => {
    const { blocks } = withinTotals([sentencesOf(8), sentencesOf(8)]);
    expect(blocks.map((block) => (block.kind === 'sentences' ? block.sentences.length : 0))).toEqual([8, 4]);
  });
});
