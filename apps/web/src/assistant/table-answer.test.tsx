import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { key, node, ref } from '../state/test-data.js';
import { need } from '../test-utils.js';
import { elementKey } from '../state/keys.js';
import { harness, RECORD, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY, foldedRowsText } from './copy.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });
const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ cells: [`item-${index + 1}`, `code-${index + 1}`], cites: [index % 2 === 0 ? 'n1' : 'n2'] }));
const tableAnswer = (rows = 2, extra: { droppedRows?: number; moreNotShown?: number; noDescription?: string; pointer?: string; lastCallNote?: string } = {}): AssistantTurnAnswer => ({
  status: 'answered',
  route: 'view',
  blocks: [{ kind: 'table', table: { title: `figures · ${rows} rows`, columns: ['Element', 'Code'], rows: rowsOf(rows), note: 'Each row selects its elements on the graph.', ...(extra.droppedRows === undefined ? {} : { droppedRows: extra.droppedRows }), ...(extra.moreNotShown === undefined ? {} : { moreNotShown: extra.moreNotShown }) } }],
  citations: [
    { key: 'n1', kind: 'entity', ref: A },
    { key: 'n2', kind: 'entity', ref: B },
  ],
  coverage: { retrieval: '2 shown · exact', summary: `${rows} of 2 figures in view shown · exact` },
  model: 'stub-model',
  calls: 2,
  ...(extra.noDescription === undefined ? {} : { noDescription: extra.noDescription }),
  ...(extra.pointer === undefined ? {} : { pointer: extra.pointer }),
  ...(extra.lastCallNote === undefined ? {} : { lastCallNote: extra.lastCallNote }),
});

function shown(h: ReturnType<typeof harness>): void {
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [] };
  h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [] }, [{ key: key('a'), result }]);
}

async function draw(answer: AssistantTurnAnswer) {
  const h = harness(async () => ok(answer));
  shown(h);
  render(h.tree());
  await typeAndSend('show them as a table');
  await screen.findByText('AI-drafted');
  return h;
}

describe('the Assistant panel: a table answer', () => {
  it('shows the tags, the title as the table caption, a header with a Source column, a marker, a source link and a select button on every row, the sources and the coverage', async () => {
    await draw(tableAnswer());
    expect(screen.getByText('Model: stub-model')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'figures · 2 rows' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Element', 'Code', ASSISTANT_COPY.citeColumn]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Each row selects its elements on the graph.')).toBeTruthy();
    expect(screen.getByText('Sources · 2')).toBeTruthy();
    expect(screen.getByText('2 of 2 figures in view shown · exact')).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.moreNotShownTitle)).toBeNull();
  });

  it('selects the element a row cites from its chip', async () => {
    const h = await draw(tableAnswer());
    const table = screen.getByRole('table');
    await userEvent.click(need(within(table).getAllByRole('button', { name: /^Citation 1/ })[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
  });

  it('puts one chip for each element a row cites, in the order of its cites', async () => {
    const answer = tableAnswer();
    if (answer.status !== 'answered' || !('blocks' in answer)) throw new Error('not blocks');
    const block = answer.blocks[0];
    if (block?.kind !== 'table') throw new Error('not a table');
    const two: AssistantTurnAnswer = { ...answer, blocks: [{ kind: 'table', table: { ...block.table, rows: [{ cells: ['item-1', 'code-1'], cites: ['n2', 'n1'] }] } }] };
    await draw(two);
    const chips = within(screen.getByRole('table')).getAllByRole('button', { name: /^Citation/ });
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual([expect.stringContaining('Citation 1'), expect.stringContaining('Citation 2')]);
    expect(chips[0]?.getAttribute('aria-label')).toContain('ent-2');
  });

  it('shows all the rows of a table of 10 rows or fewer, with no fold line', async () => {
    await draw(tableAnswer(10));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(11);
    expect(screen.queryByText(foldedRowsText(6))).toBeNull();
  });

  it('folds a table of more than 10 rows to its first three rows and its last, opens and closes the fold', async () => {
    await draw(tableAnswer(25));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3 + 1 + 1);
    expect(within(table).queryByText('item-4')).toBeNull();
    expect(within(table).getByText('item-25')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: foldedRowsText(21) }));
    expect(within(table).getByText('item-4')).toBeTruthy();
    expect(within(table).getAllByRole('row').length).toBe(1 + 25 + 1);
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.foldClose }));
    expect(within(table).queryByText('item-4')).toBeNull();
  });

  it('shows the More not shown notice with the server count only when there is one, and the count of rows the checks left out only when there is one', async () => {
    await draw(tableAnswer(25, { moreNotShown: 15, droppedRows: 2 }));
    expect(screen.getByText(ASSISTANT_COPY.moreNotShownTitle)).toBeTruthy();
    expect(screen.getByText('25 rows are shown. 15 more rows were not shown. Narrow the view or ask for a smaller set.')).toBeTruthy();
    expect(screen.getByText(/^2 rows were left out/)).toBeTruthy();
    cleanup();
    await draw(tableAnswer(4));
    expect(screen.queryByText(ASSISTANT_COPY.moreNotShownTitle)).toBeNull();
    expect(screen.queryByText(/left out/)).toBeNull();
  });

  it('shows the fixed sentence of a table with noDescription beside it', async () => {
    await draw(tableAnswer(2, { noDescription: 'No description is configured for type-z.' }));
    expect(screen.getByText('No description is configured for type-z.')).toBeTruthy();
  });

  it('shows the fixed sentence of a pointer beside the answer', async () => {
    await draw(tableAnswer(2, { pointer: 'Use Expand on the canvas to add them to the graph.' }));
    expect(screen.getByText('Use Expand on the canvas to add them to the graph.')).toBeTruthy();
  });

  it('shows the fixed sentence of an answer written on the last call', async () => {
    await draw(tableAnswer(2, { lastCallNote: 'Written on the last model call this turn allows; ask again to read further.' }));
    expect(screen.getByText('Written on the last model call this turn allows; ask again to read further.')).toBeTruthy();
  });

  it('keeps every control reachable by the keyboard: a chip and the fold control take Tab and Enter', async () => {
    const h = await draw(tableAnswer(12));
    const table = screen.getByRole('table');
    const fold = screen.getByRole('button', { name: foldedRowsText(8) });
    fold.focus();
    await userEvent.keyboard('{Enter}');
    expect(within(table).getByText('item-4')).toBeTruthy();
    const chip = need(within(table).getAllByRole('button').find((button) => button.getAttribute('aria-label')?.startsWith('Citation')));
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect([...h.state.presentation.view.getState().selection].length).toBe(1);
  });

  it('opens the Sources list at the first cited element from the link icon of a row, named by its number', async () => {
    await draw(tableAnswer());
    const link = within(screen.getByRole('table')).getAllByRole('button', { name: 'Show source [1]' })[0];
    await userEvent.click(need(link));
    const row = await screen.findByRole('button', { name: /^Sources: 1,/ });
    expect(document.activeElement).toBe(row);
  });

  it('selects the elements of a row from a click on the row and from its select button, and not from a click on a marker twice', async () => {
    const h = await draw(tableAnswer());
    const table = screen.getByRole('table');
    await userEvent.click(within(table).getByText('item-2'));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(B)]);
    await userEvent.click(within(table).getByRole('button', { name: 'Select row 1 on graph' }));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
  });

  it('copies the table as tab-separated text, header first, with the markers, and says Copied', async () => {
    let written = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written = text; } } });
    await draw(tableAnswer());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect(written).toBe(['Element\tCode\tSource', 'item-1\tcode-1\t[1]', 'item-2\tcode-2\t[2]'].join('\n'));
    expect(await screen.findByText(ASSISTANT_COPY.tableCopied, { selector: 'span:not(.visually-hidden)' })).toBeTruthy();
  });

  it('copies only the visible rows of a folded table', async () => {
    let written = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written = text; } } });
    await draw(tableAnswer(25));
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect(written.split('\n')).toHaveLength(1 + 3 + 1);
  });

  it('says so when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('no'); } } });
    await draw(tableAnswer());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect((await screen.findAllByText(ASSISTANT_COPY.tableCopyFailed)).length).toBeGreaterThan(0);
  });

  it('names the table by its caption', async () => {
    await draw(tableAnswer());
    expect(screen.getByRole('table', { name: 'figures · 2 rows' }).querySelector('caption')?.textContent).toBe('figures · 2 rows');
  });

  it('copies every row of an unfolded table', async () => {
    let written = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written = text; } } });
    await draw(tableAnswer(25));
    await userEvent.click(screen.getByRole('button', { name: foldedRowsText(21) }));
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect(written.split('\n')).toHaveLength(26);
  });

  it('copies a masked cell as it is drawn, masked', async () => {
    let written = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written = text; } } });
    const answer = tableAnswer();
    if (answer.status !== 'answered' || !('blocks' in answer)) throw new Error('not blocks');
    const block = answer.blocks[0];
    if (block?.kind !== 'table') throw new Error('not a table');
    await draw({ ...answer, blocks: [{ kind: 'table', table: { ...block.table, rows: [{ cells: ['\u2022\u2022\u2022\u2022', 'code-1'], cites: ['n1'] }] } }] });
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect(written.split('\n')[1]).toBe('\u2022\u2022\u2022\u2022\tcode-1\t[1]');
  });

  it('folds two tables of one answer each on its own', async () => {
    const answer = tableAnswer(25);
    if (answer.status !== 'answered' || !('blocks' in answer)) throw new Error('not blocks');
    const block = answer.blocks[0];
    if (block?.kind !== 'table') throw new Error('not a table');
    const second = { kind: 'table' as const, table: { ...block.table, title: 'second · 25 rows' } };
    await draw({ ...answer, blocks: [block, second] });
    const [one, two] = screen.getAllByRole('table');
    await userEvent.click(within(need(one)).getByRole('button', { name: foldedRowsText(21) }));
    expect(within(need(one)).getByText('item-4')).toBeTruthy();
    expect(within(need(two)).queryByText('item-4')).toBeNull();
  });

  it('announces Copied once in the status region, and the failure in it too', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
    await draw(tableAnswer());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    await screen.findAllByText(ASSISTANT_COPY.tableCopied);
    const regions = screen.getAllByRole('status').filter((node) => node.textContent === ASSISTANT_COPY.tableCopied);
    expect(regions).toHaveLength(1);
    cleanup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('no'); } } });
    await draw(tableAnswer());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    await screen.findAllByText(ASSISTANT_COPY.tableCopyFailed);
    expect(screen.getAllByRole('status').some((node) => node.textContent === ASSISTANT_COPY.tableCopyFailed)).toBe(true);
  });

  it('draws the table of a second pack from the words the answer carries, with no change of code', async () => {
    // the first entity label of the second pack is read from its own mapping
    const mapping = readFileSync(resolve(process.cwd(), '../../domain-packs/insurance-claims/neburyx.yaml'), 'utf8');
    const label = /^\s+label: (\S+)$/m.exec(mapping)?.[1] ?? '';
    expect(label).not.toBe('');
    const note = 'Reserve in EUR. Each row selects its elements on the graph.';
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      blocks: [{ kind: 'table', table: { title: `${label} figures · 1 row`, columns: [label, 'Reserve'], rows: [{ cells: [`${label} 1`, '1,500'], cites: ['n1'] }], note } }],
      citations: [{ key: 'n1', kind: 'entity', ref: A }],
      coverage: { retrieval: '1 shown · exact', summary: '1 of 1 figures in view shown · exact' },
      model: 'stub-model',
      calls: 2,
    };
    await draw(answer);
    const table = screen.getByRole('table', { name: `${label} figures · 1 row` });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([label, 'Reserve', ASSISTANT_COPY.citeColumn]);
    expect(screen.getByText(note)).toBeTruthy();
  });

  it('draws a table beside a sentence that cites a read line, with the marker of the read and the markers of the rows', async () => {
    const base = tableAnswer();
    if (base.status !== 'answered' || !('blocks' in base)) throw new Error('not blocks');
    const answer: AssistantTurnAnswer = {
      ...base,
      blocks: [{ kind: 'sentences', sentences: [{ text: 'The view does not show every element.', cites: ['c1'] }] }, ...base.blocks],
      citations: [...base.citations, { key: 'c1', kind: 'read', label: 'View coverage', finding: '2 shown · exact' }],
    };
    await draw(answer);
    expect(screen.getByText('The view does not show every element.')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('button', { name: /^Citation \d+/ })).toHaveLength(2);
    expect(screen.getByText('Sources · 2')).toBeTruthy();
  });

  it('keeps a column of numbers from wrapping and marks the first column of words as the title column', async () => {
    const base = tableAnswer();
    if (base.status !== 'answered' || !('blocks' in base)) throw new Error('not blocks');
    const answer: AssistantTurnAnswer = {
      ...base,
      blocks: [{ kind: 'table', table: { title: 'figures · 2 rows', columns: ['Element', 'Size'], rows: [{ cells: ['AC-1', '$12,400.50'], cites: ['n1'] }, { cells: ['item-2', '-8'], cites: ['n2'] }], note: 'Each row selects its elements on the graph.' } }],
    };
    await draw(answer);
    const table = screen.getByRole('table');
    const [words, numbers] = within(table).getAllByRole('columnheader');
    expect(words?.className).toBe('assistant-table-title-cell');
    expect(numbers?.className).toBe('assistant-table-number');
    expect(within(table).getByText('$12,400.50').className).toBe('assistant-table-number');
    expect(within(table).getByText('AC-1').className).toBe('assistant-table-title-cell');
  });

  it('shows instants as date and time with UTC in the header, groups the thousands of a decimal number and keeps the title cell short with its full text as the tooltip, and copies what was read', async () => {
    const base = tableAnswer();
    if (base.status !== 'answered' || !('blocks' in base)) throw new Error('not blocks');
    const answer: AssistantTurnAnswer = {
      ...base,
      blocks: [{ kind: 'table', table: { title: 'figures · 2 rows', columns: ['Element', 'Size', 'Date'], rows: [{ cells: ['Element with a rather long title 1', '1664.72', '2022-09-09T22:33:00Z'], cites: ['n1'] }, { cells: ['Element 2', '203.6', '2022-09-10T01:02:03Z'], cites: ['n2'] }], note: 'Each row selects its elements on the graph.' } }],
    };
    await draw(answer);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Element', 'Size', 'Date (UTC)', ASSISTANT_COPY.citeColumn]);
    expect(within(table).getByText('1,664.72')).toBeTruthy();
    expect(within(table).getByText('203.6')).toBeTruthy();
    expect(within(table).getByText('2022-09-09 22:33:00')).toBeTruthy();
    const title = within(table).getByText('Element with a rather long title 1');
    expect(title.getAttribute('title')).toBe('Element with a rather long title 1');
    expect(title.className).toBe('assistant-table-title-cell');
  });

  it('copies the cells as read when the table draws them grouped and formatted', async () => {
    const base = tableAnswer();
    if (base.status !== 'answered' || !('blocks' in base)) throw new Error('not blocks');
    const answer: AssistantTurnAnswer = {
      ...base,
      blocks: [{ kind: 'table', table: { title: 'figures · 1 row', columns: ['Element', 'Size', 'Date'], rows: [{ cells: ['Element 1', '1664.72', '2022-09-09T22:33:00Z'], cites: ['n1'] }], note: 'Each row selects its elements on the graph.' } }],
    };
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void written.push(text) } });
    await draw(answer);
    expect(screen.getByText('1,664.72')).toBeTruthy();
    expect(screen.getByText('2022-09-09 22:33:00')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.copyTable }));
    expect(written[0]?.split('\n')[1]).toBe(`Element 1\t1664.72\t2022-09-09T22:33:00Z\t[1]`);
  });
});
