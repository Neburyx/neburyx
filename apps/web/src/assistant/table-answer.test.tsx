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
const tableAnswer = (rows = 2, extra: { droppedRows?: number; moreNotShown?: number; noDescription?: string } = {}): AssistantTurnAnswer => ({
  status: 'answered',
  route: 'view',
  table: { title: `figures · ${rows} rows`, columns: ['Element', 'Code'], rows: rowsOf(rows), ...(extra.droppedRows === undefined ? {} : { droppedRows: extra.droppedRows }), ...(extra.moreNotShown === undefined ? {} : { moreNotShown: extra.moreNotShown }) },
  citations: [
    { key: 'n1', kind: 'entity', ref: A },
    { key: 'n2', kind: 'entity', ref: B },
  ],
  coverage: { retrieval: '2 shown · exact', summary: `${rows} of 2 figures in view shown · exact` },
  model: 'stub-model',
  calls: 2,
  ...(extra.noDescription === undefined ? {} : { noDescription: extra.noDescription }),
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
  it('shows the tags, the title as the table caption, a header with a Cite column, a chip on every row, the sources and the coverage', async () => {
    await draw(tableAnswer());
    expect(screen.getByText('Model: stub-model')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'figures · 2 rows' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Element', 'Code', ASSISTANT_COPY.citeColumn]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Sources · 2')).toBeTruthy();
    expect(screen.getByText('2 of 2 figures in view shown · exact')).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.moreNotShownTitle)).toBeNull();
  });

  it('selects the element a row cites from its chip', async () => {
    const h = await draw(tableAnswer());
    const table = screen.getByRole('table');
    await userEvent.click(need(within(table).getAllByRole('button')[0]));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
  });

  it('puts one chip for each element a row cites, in the order of its cites', async () => {
    const answer = tableAnswer();
    if (answer.status !== 'answered' || !('table' in answer)) throw new Error('not a table');
    const two = { ...answer, table: { ...answer.table, rows: [{ cells: ['item-1', 'code-1'], cites: ['n2', 'n1'] }] } };
    await draw(two);
    const chips = within(screen.getByRole('table')).getAllByRole('button');
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
});
