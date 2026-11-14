import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AskPatternCard, AskPlan } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult, AskRunAnswer } from '../api/client.js';
import { answer, button, cleanup, drawPlan, hasButton, NODE, ok, PLAN_ID, TOKEN } from './plan-kit.js';
import { planFailureWords } from './plan-failure.js';

afterEach(cleanup);

const ID = '0192f000-0000-7000-8000-0000000000b1';
const STEP = { relationshipTypes: ['HOLDS'], direction: 'out' as const, arrivesAt: 'gadget', conditions: [], windowed: false };
const CARD: AskPatternCard = { name: 'Ring members', projection: { kind: 'definition', anchorType: 'widget', startingEntity: 'asked', steps: [STEP] } };
const plan = (): AskPlan => ({ kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'Ring members through the holdings.', params: { patternId: ID, patternVersion: 3, ref: { entityType: 'widget', stableId: 'w-1' } } }) as AskPlan;
const savedResult = (): AskRunAnswer => ({ planId: PLAN_ID, outcome: 'complete', result: { templateId: 'saved-pattern', result: { status: 'ok', templateVersion: '3', count: { quality: 'exact', value: 1, scope: 'test' }, matches: [], nodes: [NODE('w-1')], edges: [], notices: [], warnings: [] } } }) as AskRunAnswer;
const spy = () => {
  const calls: string[] = [];
  return { calls, client: { listPatterns: async () => (calls.push('list'), { ok: true, value: { items: [], nextCursor: null } }) as ApiResult<never> } };
};

describe('the plan card of a saved pattern', () => {
  it('shows the name and the steps the server read for the caller, and where it starts, with the read-only line and no internal id, no rationale and no request for the list', async () => {
    const { calls, client } = spy();
    await drawPlan(plan(), { card: CARD, client });
    expect(screen.getByText('Saved pattern')).toBeTruthy();
    expect(screen.queryByText('saved-pattern')).toBeNull();
    expect(screen.getByText('Pattern', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Ring members');
    expect(screen.getByText('Path', { selector: 'dt' }).nextElementSibling?.textContent).toBe('widget → HOLDS → gadget');
    expect(screen.getByText('Starts from', { selector: 'dt' }).nextElementSibling?.textContent).toBe('widget · w-1');
    expect(screen.getByText('Read-only · same limits as manual exploration')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Review before running' }).textContent).not.toContain('through the holdings');
    expect(button('Run').disabled).toBe(false);
    expect(calls).toEqual([]);
  });

  it('draws a saved run of a preset as its start type, relationship type and the type reached', async () => {
    await drawPlan(plan(), { card: { name: 'Shared devices', projection: { kind: 'preset-run', template: 'shared-attribute', anchorType: 'widget', startingEntity: 'asked', otherType: 'gadget', relationshipTypes: ['HOLDS'], windowed: false } } });
    expect(screen.getByText('Path', { selector: 'dt' }).nextElementSibling?.textContent).toBe('widget → HOLDS → gadget');
  });

  it('draws the arrow of a saved run of a preset in its own direction', async () => {
    await drawPlan(plan(), { card: { name: 'Linked', projection: { kind: 'preset-run', template: 'linked-entities', anchorType: 'widget', startingEntity: 'asked', otherType: 'gadget', relationshipTypes: ['HOLDS'], direction: 'in', windowed: false } } });
    expect(screen.getByText('Path', { selector: 'dt' }).nextElementSibling?.textContent).toBe('widget ← HOLDS ← gadget');
  });

  it('shows no name when the server read none, and still lets the plan run, since the run is the check', async () => {
    await drawPlan(plan());
    expect(screen.queryByText('Pattern', { selector: 'dt' })).toBeNull();
    expect(button('Run').disabled).toBe(false);
  });

  it('says that more patterns exist than were offered when the answer says so, and nothing otherwise', async () => {
    await drawPlan(plan(), { card: CARD, cut: true });
    expect(screen.getByText('More saved patterns exist than were offered to Ask.')).toBeTruthy();
    cleanup();
    await drawPlan(plan(), { card: CARD });
    expect(screen.queryByText(/More saved patterns/)).toBeNull();
  });

  it('shows Edit disabled with the reason, keeps Run, Ask again and Cancel, and sends no edit', async () => {
    const { edits } = await drawPlan(plan(), { card: CARD });
    expect(button('Edit').disabled).toBe(true);
    expect(button('Edit').getAttribute('aria-describedby')).toBe(screen.getByText(/cannot be edited here/).id);
    expect(['Run', 'Ask again', 'Cancel'].every(hasButton)).toBe(true);
    await userEvent.click(button('Edit'));
    expect(edits.length).toBe(0);
  });

  it('runs on Run with the plan ID only, never the name, and draws the result', async () => {
    const { runs } = await drawPlan(plan(), { card: CARD });
    expect(runs.length).toBe(0);
    await userEvent.click(button('Run'));
    expect(runs[0]?.request).toEqual({ planId: PLAN_ID });
    await answer(runs[0], ok(savedResult()));
    expect(screen.getByRole('region', { name: 'Review before running' }).textContent).toContain('Ran saved-pattern');
  });

  it('draws the answer of a saved-pattern run under its result, with its sources, by the card that draws it for a template', async () => {
    const { runs } = await drawPlan(plan(), { card: CARD });
    await userEvent.click(button('Run'));
    const summary = {
      sentences: [{ text: 'Matches of the saved pattern from Widget w-1: 1 · exact.', cites: ['n1'] }],
      citations: [{ key: 'n1', element: NODE('w-1').ref, type: 'widget', title: 'Widget w-1' }],
      omissions: '1 shown.',
    };
    await answer(runs[0], ok({ ...savedResult(), summary } as AskRunAnswer));
    const section = screen.getByRole('region', { name: 'Answer' });
    expect(within(section).getAllByRole('listitem')[0]?.textContent).toBe('Matches of the saved pattern from Widget w-1: 1 · exact.[1]');
    expect(within(section).getByText('1 shown.')).toBeTruthy();
  });

  it.each([
    [{ code: 'CONFLICT', details: { reason: 'pattern-changed' } }, /changed after the plan was made, so it did not run/],
    [{ code: 'CONFLICT', details: { reason: 'pattern-unavailable' } }, /no longer available to you, so it did not run/],
    [{ code: 'NOT_FOUND' }, /plan or its saved pattern is no longer available to you/],
  ])('says in plain words that the pattern changed or is gone when the run answers %j, offers Ask again and shows no result', async (failure, words) => {
    const { runs } = await drawPlan(plan(), { card: CARD });
    await userEvent.click(button('Run'));
    await answer(runs[0], { ok: false, failure } as ApiResult<AskRunAnswer>);
    expect(screen.getByText(words)).toBeTruthy();
    expect(hasButton('Ask again')).toBe(true);
    expect(screen.queryByText(/Ran saved-pattern/)).toBeNull();
  });

  it('shows the estimate of a heavy run and reads nothing more until it is continued', async () => {
    const { runs } = await drawPlan(plan(), { card: CARD });
    await userEvent.click(button('Run'));
    const heavy = { planId: PLAN_ID, outcome: 'partial', result: { templateId: 'saved-pattern', result: { status: 'heavy', templateVersion: '3', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } }, continueToken: TOKEN } as AskRunAnswer;
    await answer(runs[0], ok(heavy));
    expect(screen.getByText('This would read more than the source allows without asking.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Review before running' }).textContent).toContain('1000');
    expect(runs.length).toBe(1);
  });

  it('draws no pattern lines for a plan of a template, and still shows its ID', async () => {
    await drawPlan();
    expect(screen.queryByText('Starts from')).toBeNull();
    expect(screen.getByText('shared-attribute')).toBeTruthy();
  });
});

describe('the words of a failed call on a plan', () => {
  const gone = { code: 'NOT_FOUND' } as never;
  it('keeps the plan-only sentence for a plan of a template and names the pattern too for a saved pattern', () => {
    expect(planFailureWords(gone, 'a', 'run').text).toBe('This plan is no longer there. Ask the question again.');
    expect(planFailureWords(gone, 'a', 'run', true).text).toBe('This plan or its saved pattern is no longer available to you. Ask the question again.');
  });
});
