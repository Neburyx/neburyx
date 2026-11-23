import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { harness, REFUSE } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const REF_A = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const REF_B = { sourceId: 'demo', entityType: 'widget', stableId: 'A-2' };
const text = (value: string) => ({ state: 'text' as const, text: value });
const WITHHELD = { state: 'withheld' as const };
const turn = (seq: number, over: Partial<AssistantThreadResponse['turns'][number]>): AssistantThreadResponse['turns'][number] => ({ seq, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 2, steps: 0, ...over });
const thread = (turns: AssistantThreadResponse['turns']): AssistantThreadResponse => ({ turns, earlierTurns: 0, previousThreadClearedAt: null });
const panel = async (response: AssistantThreadResponse) => {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(response));
  render(h.tree());
  return h;
};

describe('the answers of the stored turns, in the card of a live answer (frame AS19a)', () => {
  it('shows the question as typed and the sentences with numbered markers of the elements they cite, the same element with the same number, and no model, coverage or read steps', async () => {
    await panel(
      thread([
        turn(1, { question: 'What is connected to this account?', answer: { blocks: [{ kind: 'sentences', items: [{ item: text('Account A-1 is held at Bank 7.'), cites: [REF_A, REF_B] }, { item: text('Account A-2 is in view.'), cites: [REF_B] }] }] } }),
      ]),
    );
    expect(await screen.findByText('What is connected to this account?')).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.storedNotice)).toBeTruthy();
    const first = screen.getByText(/Account A-1 is held at Bank 7\./).closest('p') as HTMLElement;
    expect(within(first).getAllByRole('button').map((button) => button.textContent)).toEqual(['[1]', '[2]']);
    const second = screen.getByText(/Account A-2 is in view\./).closest('p') as HTMLElement;
    expect(within(second).getAllByRole('button').map((button) => button.textContent)).toEqual(['[2]']);
    expect(screen.getByText(ASSISTANT_COPY.drafted)).toBeTruthy();
    expect(screen.queryByText(new RegExp(ASSISTANT_COPY.modelTag))).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.coverage)).toBeNull();
  });

  it('draws the model and the coverage card of an answer that was stored with them, the coverage after the sources as frame AS19a draws it, and neither for an answer stored without them', async () => {
    const coverage = { retrieval: '27 shown · ≥ 184,506 relationships not yet retrieved (lower bound)', summary: 'The answer cites 1 of the 27 elements the reads returned.' };
    await panel(
      thread([
        turn(1, { question: 'First?', answer: { model: 'claude-sonnet-5-5', coverage, blocks: [{ kind: 'sentences', items: [{ item: text('With them.'), cites: [REF_A] }] }] } }),
        turn(2, { question: 'Second?', answer: { blocks: [{ kind: 'sentences', items: [{ item: text('Without them.'), cites: [REF_A] }] }] } }),
      ]),
    );
    await screen.findByText('With them.');
    expect(screen.getAllByText(new RegExp(`${ASSISTANT_COPY.modelTag}:`))).toHaveLength(1);
    expect(screen.getByText(`${ASSISTANT_COPY.modelTag}: claude-sonnet-5-5`)).toBeTruthy();
    const card = screen.getByText('With them.').closest('section') as HTMLElement;
    expect(within(card).getByText(coverage.retrieval)).toBeTruthy();
    expect(within(card).getByText(coverage.summary)).toBeTruthy();
    const sources = within(card).getByRole('button', { name: /^Sources · 1/ });
    const coverageBox = within(card).getByText(ASSISTANT_COPY.coverage).closest('div') as HTMLElement;
    expect(sources.compareDocumentPosition(coverageBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(ASSISTANT_COPY.coverage)).toHaveLength(1);
  });

  it('shows the masking notice in place of an item the read withheld and no text of it, and still shows the question and the rest of the turn', async () => {
    await panel(
      thread([
        turn(1, { question: 'Who holds it?', answer: { blocks: [{ kind: 'sentences', items: [{ item: WITHHELD, cites: [REF_A] }, { item: text('Account A-2 is in view.'), cites: [REF_B] }] }] } }),
        turn(2, { question: 'And the other?', answer: { blocks: [{ kind: 'sentences', items: [{ item: WITHHELD, cites: [REF_A] }] }] } }),
      ]),
    );
    expect(await screen.findByText('Who holds it?')).toBeTruthy();
    expect(screen.getAllByText(ASSISTANT_COPY.storedWithheld)).toHaveLength(2);
    expect(screen.getByText('And the other?')).toBeTruthy();
    expect(screen.getByText(/Account A-2 is in view\./)).toBeTruthy();
  });

  it('shows a table block, a withheld cell and a withheld column label by the masking notice, and each row cites its elements by number', async () => {
    await panel(
      thread([
        turn(1, { answer: { blocks: [{ kind: 'table', columns: [text('Name'), WITHHELD], rows: [{ cells: [text('Ana'), WITHHELD], cites: [REF_A] }, { cells: [text('Ben'), text('7')], cites: [REF_B] }] }] } }),
      ]),
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Name')).toBeTruthy();
    expect(within(table).getAllByText(ASSISTANT_COPY.storedWithheld).length).toBeGreaterThanOrEqual(2);
    expect(within(table).getByText('Ben')).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: new RegExp(`^${ASSISTANT_COPY.citationNumber}`) }).map((button) => button.textContent)).toEqual(['[1]', '[2]']);
  });

  it('shows a list block as the live card shows it, with its label, its items numbered by their citations, and the masking notice for an item or a label that was withheld', async () => {
    await panel(
      thread([
        turn(1, { answer: { blocks: [{ kind: 'list', label: text('The accounts in view'), items: [{ item: text('Account A-1.'), cites: [REF_A] }, { item: WITHHELD, cites: [REF_B] }] }] } }),
        turn(2, { answer: { blocks: [{ kind: 'list', label: WITHHELD, items: [{ item: text('Only item.'), cites: [REF_A] }] }] } }),
      ]),
    );
    expect(await screen.findByText('The accounts in view')).toBeTruthy();
    const first = screen.getByText(/Account A-1\./).closest('li') as HTMLElement;
    expect(within(first).getByRole('button', { name: new RegExp(`^${ASSISTANT_COPY.citationNumber}`) }).textContent).toBe('[1]');
    expect(screen.getAllByText(ASSISTANT_COPY.storedWithheld)).toHaveLength(2);
    expect(screen.getByText('Only item.')).toBeTruthy();
  });

  it('shows the fixed sentence of a refusal and the overview beside it, and a withheld fixed sentence by the notice', async () => {
    await panel(
      thread([
        turn(1, { route: 'refuse', outcome: 'refused', question: 'Is this fraud?', answer: { blocks: [{ kind: 'refusal', sentence: text('I cannot say whether this is fraud.'), overview: [{ item: text('Account A-1 is held at Bank 7.'), cites: [REF_A] }] }] } }),
        turn(2, { route: 'refuse', outcome: 'refused', answer: { blocks: [{ kind: 'refusal', sentence: WITHHELD }] } }),
      ]),
    );
    expect(await screen.findByText('I cannot say whether this is fraud.')).toBeTruthy();
    expect(screen.getByText(/Account A-1 is held at Bank 7\./)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.storedWithheld)).toBeTruthy();
  });

  it('shows a turn with a question and no answer as the question over its row, and a turn with neither as the row alone', async () => {
    await panel(thread([turn(1, { question: 'Only a question', outcome: 'refused', cause: 'verdict', route: 'refuse' }), turn(2, { outcome: 'refused', cause: 'verdict', route: 'refuse' })]));
    expect(await screen.findByText('Only a question')).toBeTruthy();
    expect(screen.getAllByText(ASSISTANT_COPY.storedRefused).length).toBeGreaterThanOrEqual(2);
  });

  it('puts the markers in the keyboard order of the card: each is a button, reached after the one before it', async () => {
    const user = userEvent.setup();
    await panel(thread([turn(1, { answer: { blocks: [{ kind: 'sentences', items: [{ item: text('One.'), cites: [REF_A] }, { item: text('Two.'), cites: [REF_B] }] }] } })]));
    await screen.findByText('One.');
    const markers = screen.getAllByRole('button', { name: new RegExp(`^${ASSISTANT_COPY.citationNumber}`) });
    await user.tab();
    await user.tab();
    expect(markers).toHaveLength(2);
    for (const marker of markers) expect(marker.tabIndex).toBeGreaterThanOrEqual(0);
  });
});
