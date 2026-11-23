import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { key, node, ref } from '../state/test-data.js';
import { elementKey } from '../state/keys.js';
import { harness, RECORD, typeAndSend } from './assistant-kit.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const ok = (value: AssistantTurnAnswer) => ({ ok: true as const, value });

const answerOf = (blocks: Extract<AssistantTurnAnswer, { status: 'answered'; blocks: unknown }>['blocks'], extra: Record<string, unknown> = {}): AssistantTurnAnswer =>
  ({
    status: 'answered',
    route: 'view',
    blocks,
    citations: [
      { key: 'n1', kind: 'entity', ref: A },
      { key: 'n2', kind: 'entity', ref: B },
    ],
    coverage: { retrieval: '2 shown · exact', summary: 'The answer cites 2 of the 2 shown elements.' },
    model: 'stub-model',
    calls: 2,
    ...extra,
  }) as AssistantTurnAnswer;

const listOf = (): HTMLElement => {
  const list = document.querySelector<HTMLElement>('ul.assistant-list-items');
  if (list === null) throw new Error('no list drawn');
  return list;
};

async function draw(answer: AssistantTurnAnswer) {
  const h = harness(async () => ok(answer));
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [] };
  h.state.show({ id: 'inv-2', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [] }, [{ key: key('a'), result }]);
  render(h.tree());
  await typeAndSend('show where it came from');
  await screen.findByText('AI-drafted');
  return h;
}

describe('the Assistant panel: a list block', () => {
  it('draws the label and the items as a list named by the label, each item with its markers', async () => {
    await draw(answerOf([{ kind: 'list', label: 'Where it came from', items: [{ text: 'Owner: one.', cites: ['n1'] }, { text: 'Bank: two.', cites: ['n2', 'n1'] }] }]));
    const list = screen.getByRole('list', { name: 'Where it came from' });
    expect(screen.getByText('Where it came from').className).toContain('assistant-list-label');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Owner: one. [1]', 'Bank: two. [2] [1]']);
  });

  it('draws a list with no label as a list with no name, and nothing else', async () => {
    await draw(answerOf([{ kind: 'list', items: [{ text: 'Owner: one.', cites: ['n1'] }] }]));
    expect(document.querySelector('.assistant-list-label')).toBeNull();
    expect(listOf().getAttribute('aria-labelledby')).toBeNull();
  });

  it('selects the element of an item from its marker, as a sentence marker does', async () => {
    const h = await draw(answerOf([{ kind: 'list', items: [{ text: 'Owner: one.', cites: ['n2'] }] }]));
    const marker = within(listOf()).getByRole('button', { name: /^Citation 1, / });
    await userEvent.click(marker);
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(B)]);
  });

  it('works the read chip of an item that cites a read line', async () => {
    await draw(answerOf([{ kind: 'list', items: [{ text: 'The read found nothing.', cites: ['s1'] }] }], { citations: [{ key: 'n1', kind: 'entity', ref: A }, { key: 's1', kind: 'read', label: 'expand', finding: '0 shown · exact' }] }));
    const chip = within(listOf()).getByRole('button', { name: 'Read: expand' });
    await userEvent.click(chip);
    expect(screen.getByText('0 shown · exact')).toBeTruthy();
  });

  it('keeps the model order of sentences, a table and a list, and numbers every citation once across them', async () => {
    await draw(
      answerOf([
        { kind: 'sentences', sentences: [{ text: 'Two are in view.', cites: ['n1', 'n2'] }] },
        { kind: 'table', table: { title: 'figures · 1 row', columns: ['Element'], rows: [{ cells: ['item-1'], cites: ['n2'] }], note: 'Each row selects its elements on the graph.' } },
        { kind: 'list', label: 'Details', items: [{ text: 'Owner: one.', cites: ['n1'] }] },
      ]),
    );
    const sections = [...document.querySelectorAll('.assistant-view-answer > div')].map((block) => (block.querySelector('table') ? 'table' : block.querySelector('ul') ? 'list' : block.querySelector('ol') ? 'sentences' : 'other')).filter((kind) => kind !== 'other');
    expect(sections).toEqual(['sentences', 'table', 'list']);
    expect(screen.getByText('Sources · 2')).toBeTruthy();
    const numbers = [...document.querySelectorAll('.assistant-marker')].map((marker) => marker.textContent);
    expect(new Set(numbers)).toEqual(new Set(['[1]', '[2]']));
  });

  it('works the description chip of an item that cites an operator description', async () => {
    const meaning = { key: 'm1', kind: 'description' as const, typeKind: 'entity' as const, type: 'Widget', description: 'A widget holds a balance.' };
    await draw(answerOf([{ kind: 'list', items: [{ text: 'A widget holds a balance.', cites: ['m1'] }] }], { citations: [{ key: 'n1', kind: 'entity', ref: A }, meaning] }));
    const chip = within(listOf()).getByRole('button', { name: /^About Widget: / });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('A widget holds a balance.', { selector: '.assistant-description span:last-child' })).toBeTruthy();
  });
});
