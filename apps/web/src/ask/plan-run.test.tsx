import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { server, field } from './ask-kit.js';
import { answer, button, cleanup, count, drawPlan, EXPIRES, hasButton, heavyResult, NODE, ok, PLAN_ID, sharedPlan, sharedResult, TOKEN } from './plan-kit.js';

afterEach(cleanup);

const status = (): string => screen.getByText(/./, { selector: '.ask-plan-status' }).textContent ?? '';
const failure = (code: string, details?: Record<string, unknown>) => server(code, details);

describe('Run, when it fails', () => {
  it.each([
    ['an expired plan', failure('CONFLICT', { reason: 'plan-expired' }), 'This plan expired. Ask the question again.'],
    ['a plan that can no longer be run', failure('CONFLICT', { reason: 'plan-not-runnable' }), 'This plan can no longer be run. Ask the question again.'],
    ['a plan that is not there', failure('NOT_FOUND'), 'This plan is no longer there. Ask the question again.'],
    ['a plan that ran but could not be recorded', failure('AUDIT_UNAVAILABLE'), 'The plan ran but could not be recorded, so its result is not shown and it cannot run again. Ask the question again.'],
    ['a network failure', { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } }, 'The plan may have run, and its result cannot be shown again. Ask the question again.'],
    ['an internal error', failure('INTERNAL_ERROR'), 'The plan may have run, and its result cannot be shown again. Ask the question again.'],
  ])('shows the words for %s, offers only Ask again, and draws no result', async (_name, result, words) => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], result as never);
    expect(status()).toBe(words);
    expect(hasButton('Ask again')).toBe(true);
    expect(hasButton('Run')).toBe(false);
    expect(hasButton('Try again')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
  });

  it('says what the manual route says for a source that is down, with Ask again, not Try again, since the plan is spent', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], failure('SOURCE_UNAVAILABLE', { reason: 'unreachable' }) as never);
    expect(hasButton('Ask again')).toBe(true);
    expect(hasButton('Try again')).toBe(false);
  });

  it('returns to the question with its preview when Ask again is pressed, so nothing is sent without Send', async () => {
    const { runs, asks } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], failure('CONFLICT', { reason: 'plan-expired' }) as never);
    await userEvent.click(button('Ask again'));
    expect(screen.queryByRole('region', { name: 'Review before running' })).toBeNull();
    expect(screen.getByRole('region', { name: 'What the model will receive' })).toBeTruthy();
    expect(button('Send').disabled).toBe(false);
    expect(asks).toHaveLength(2);
  });

  it('refuses an answer for another plan as a failure, never as a result', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], { ok: false, failure: { code: 'SCHEMA_MISMATCH' } } as never);
    expect(status()).toContain('may have run');
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
  });
});

describe('Run, once pressed', () => {
  it('sends one request for the plan, shows Running with the buttons disabled, and makes one request for two presses', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await userEvent.click(button('Run'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.request).toEqual({ planId: PLAN_ID });
    expect(status()).toBe('Running…');
    for (const name of ['Run', 'Edit', 'Cancel']) expect(button(name).disabled).toBe(true);
  });

  it('sends the mask of the session', async () => {
    const harness = await drawPlan();
    cleanup();
    harness.state.setMask(true);
    const masked = await drawPlan(sharedPlan(), { state: harness.state });
    await userEvent.click(button('Run'));
    expect(masked.runs[0]?.request).toEqual({ planId: PLAN_ID, mask: true });
  });

  it('says what ran, in seconds and how it ended, with each count in its own quality label', async () => {
    for (const [quality, label] of [['exact', '2 · exact'], ['estimated', '~ 2 (estimated)'], ['lowerBound', '≥ 2 · lower bound'], ['unknown', 'no count']] as const) {
      const { runs } = await drawPlan();
      await userEvent.click(button('Run'));
      await answer(runs[0], ok(sharedResult(quality)));
      expect(status()).toMatch(quality === 'lowerBound' ? /^Ran shared-attribute · \d+\.\d\d s · partial$/ : /^Ran shared-attribute · \d+\.\d\d s · complete$/);
      expect(screen.getByText('Matches', { selector: 'dt' }).nextElementSibling?.textContent).toBe(label);
      cleanup();
    }
  });

  it('shows the notices of the run in the words of the patterns results', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(sharedResult('lowerBound')));
    expect(screen.getByText('The read was cut, so the count is a lower bound.')).toBeTruthy();
  });
});

describe('Add to graph', () => {
  it('merges the nodes of the result into the loaded graph, selects them and says what was added', async () => {
    const harness = await drawPlan();
    const { runs, state } = harness;
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(sharedResult('exact')));
    expect(button('Add to graph').disabled).toBe(true);
    expect(state.loadedGraph().nodes).toHaveLength(0);
  });

  it('draws nothing and offers no Add for a result with no node to draw', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok({ planId: PLAN_ID, outcome: 'complete', result: { templateId: 'degree-preview', result: { ref: NODE('w-1').ref, total: count('exact', 3), byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 } } } as never));
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull();
    expect(screen.getByText('This result has nothing to draw on the graph.')).toBeTruthy();
    expect(screen.getByText('Relationships', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3 · exact');
  });
});

describe('a run that stops as heavy', () => {
  it('shows the estimate with its label, the threshold and Continue and Cancel, and never says partial', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(heavyResult()));
    expect(screen.getByText('Estimate', { selector: 'dt' }).nextElementSibling?.textContent).toBe('≥ 1,000 · lower bound');
    expect(screen.getByText('Threshold', { selector: 'dt' }).nextElementSibling?.textContent).toBe('1000');
    expect(hasButton('Continue')).toBe(true);
    expect(hasButton('Cancel')).toBe(true);
    expect(status()).not.toMatch(/Ran|partial/);
  });

  it('sends continue with the token it was given, once, and ends as a run of its own', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(heavyResult()));
    await userEvent.click(button('Continue'));
    expect(hasButton('Continue')).toBe(false);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.request).toEqual({ planId: PLAN_ID, continue: true, continueToken: TOKEN });
    await answer(runs[1], ok(sharedResult('lowerBound')));
    expect(status()).toMatch(/^Ran shared-attribute · \d+\.\d\d s · partial$/);
  });

  it('says to run the plan again when the server did not accept the token, and the plan is still there to run', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(heavyResult()));
    await userEvent.click(button('Continue'));
    await answer(runs[1], failure('INVALID_REQUEST') as never);
    expect(status()).toBe('That continue is no longer valid. Run the plan again to get a new one.');
    await userEvent.click(button('Run again'));
    expect(hasButton('Run')).toBe(true);
  });

  it('is cancelled by Cancel, which cancels the plan that is proposed again', async () => {
    const { runs, cancels } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(heavyResult()));
    await userEvent.click(button('Cancel'));
    expect(cancels[0]?.request).toEqual({ planId: PLAN_ID });
  });
});

describe('an answer that arrives too late', () => {
  it('cannot be made late by the question: the field and Preview are locked while a run is out, and free again after its answer', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    expect(field().disabled).toBe(true);
    expect(button('Preview').disabled).toBe(true);
    await answer(runs[0], ok(sharedResult('exact')));
    expect(field().disabled).toBe(false);
  });

  it('says the plan may have run when the investigation changed while it was out', async () => {
    const { runs, state } = await drawPlan();
    await userEvent.click(button('Run'));
    act(() => state.bindSource('other'));
    await answer(runs[0], ok(sharedResult('exact')));
    expect(screen.queryByText(/^Ran /)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('A plan was running when the investigation changed. It may have run; ask again to see a result.');
  });

  it('keeps the expiry the server gave in the card state, and has no timer that runs the plan', async () => {
    const { runs } = await drawPlan();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(0);
    expect(EXPIRES).toBe('2026-11-13T10:15:00.000Z');
  });
});

describe('Add to graph, with the person known', () => {
  it('merges the nodes of the result through the patterns path, selects them, and says what was added with the count of the run', async () => {
    const { runs, state } = await drawPlan(sharedPlan(), { shell: true });
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(sharedResult('lowerBound')));
    await userEvent.click(button('Add to graph'));
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['w-1', 'w-2']);
    expect(screen.getByText(/Added 2 entities and 0 relationships\./)).toBeTruthy();
    expect(screen.getByText(/more matches may exist and were not loaded/)).toBeTruthy();
    expect(hasButton('Add to graph')).toBe(false);
  });

  it('adds the node of an entity, and the exact nodes of a search', async () => {
    const entity = await drawPlan({ kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'x', params: { ref: { entityType: 'widget', stableId: 'w-1' } } } as never, { shell: true });
    await userEvent.click(button('Run'));
    await answer(entity.runs[0], ok({ planId: PLAN_ID, outcome: 'complete', result: { templateId: 'entity', result: NODE('w-1') } } as never));
    await userEvent.click(button('Add to graph'));
    expect(entity.state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['w-1']);
  });
});

describe('Run, with the session changing under it', () => {
  it('does not draw the answer of a run that was read under another mask: it is cleared, with Ask again only', async () => {
    const { runs, state } = await drawPlan();
    await userEvent.click(button('Run'));
    act(() => state.setMask(true));
    await answer(runs[0], ok(sharedResult('exact')));
    expect(screen.queryByText(/^Ran /)).toBeNull();
    expect(status()).toBe('Masking changed, so this result is cleared. Ask again to see it.');
    expect(hasButton('Ask again')).toBe(true);
    expect(hasButton('Add to graph')).toBe(false);
  });

  it('clears a result when masking changes, with words of its own and only Ask again, since the plan has run', async () => {
    const { runs, state } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(sharedResult('exact')));
    expect(status()).toMatch(/^Ran /);
    act(() => state.setMask(true));
    expect(status()).toBe('Masking changed, so this result is cleared. Ask again to see it.');
    expect(hasButton('Ask again')).toBe(true);
    expect(hasButton('Run')).toBe(false);
  });

  it('leaves the card as it was when the client did not send the call (the source changed), so a plan that can still run still can', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    await answer(runs[0], { ok: false, failure: { code: 'ABORTED' } } as never);
    expect(hasButton('Run')).toBe(true);
    expect(status()).toBe('The plan is ready. Nothing has run.');
  });

  it('keeps the panel from being closed while a run is out, and lets it close after the answer', async () => {
    const { runs } = await drawPlan();
    await userEvent.click(button('Run'));
    expect(button('Close Ask').disabled).toBe(true);
    await answer(runs[0], ok(sharedResult('exact')));
    expect(button('Close Ask').disabled).toBe(false);
  });

  it('does not let the answer of a plan that was replaced open the press guard of the new plan', async () => {
    const { runs, asks } = await drawPlan();
    await userEvent.click(button('Run'));
    // the question is asked again while the old run is out: the field is locked, so the card is only replaced by an answer of the same send; the old answer then arrives
    await answer(runs[0], ok(sharedResult('exact')));
    expect(asks).toHaveLength(2);
    expect(runs).toHaveLength(1);
  });
});

describe('Add to graph, the words of what was added', () => {
  it('says what was added and what the graph held for every template, not only the template runs', async () => {
    const entity = await drawPlan({ kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'x', params: { ref: { entityType: 'widget', stableId: 'w-1' } } } as never, { shell: true });
    await userEvent.click(button('Run'));
    await answer(entity.runs[0], ok({ planId: PLAN_ID, outcome: 'complete', result: { templateId: 'entity', result: NODE('w-1') } } as never));
    await userEvent.click(button('Add to graph'));
    expect(screen.getByText('Added 1 entity and 0 relationships.')).toBeTruthy();
  });
});
