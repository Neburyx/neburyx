import { summaryResponseSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { ref } from '../state/test-data.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { bindSummaryPanel } from './summary-binder.js';
import { EMPTY_SUMMARY_SESSION, summarySessionOf } from './summary-session.js';

function bound() {
  const state = createClientState();
  const unbind = bindSummaryPanel(state, createPanelRegistryFor(state));
  const session = summarySessionOf(state);
  if (session === undefined) throw new Error('the session was not registered');
  session.setState({ ...EMPTY_SUMMARY_SESSION, investigationId: 'i-1', attempt: { kind: 'outcome', outcome: { kind: 'cleared', reason: 'investigation' } }, copies: 2 });
  return { state, session, unbind };
}

const SENTINEL = 'ZQSENTINEL Ana';

function completed() {
  const response = summaryResponseSchema.parse({
    status: 'ok',
    sentences: [{ text: `${SENTINEL} opened the account.`, cites: ['n1'], storable: true }],
    citations: [{ key: 'n1', kind: 'entity', ref: ref('demo', 'type-a', 'A') }],
    coverage: { retrieval: '1 shown', summary: 'The draft cites 1 of the 1 shown elements' },
    removedCount: 0,
    sent: `n1 type-a ${SENTINEL}`,
    model: 'stub-model',
    calls: 1,
    summaryToken: 'tok',
  });
  if (response.status !== 'ok') throw new Error('not a draft');
  return { response, entries: [{ key: 'n1', number: 1, kind: 'entity' as const, graphKey: 'k', label: SENTINEL }], edits: new Map([[0, `${SENTINEL} edited`]]), viewLine: `${SENTINEL} view`, arrivedAt: 0 };
}

const heldText = (value: unknown): string => JSON.stringify(value, (_key, held: unknown) => (held instanceof Map ? [...held] : held));

describe('the summary session while its panel is closed', () => {
  it('is cleared when masking is turned on, with the note that masking cleared it, and stays cleared when masking is turned off before the panel opens again', () => {
    const { state, session, unbind } = bound();
    state.setMask(true);
    expect(session.getState()).toMatchObject({ investigationId: 'i-1', mask: true, draft: undefined, attempt: { kind: 'outcome', outcome: { kind: 'cleared', reason: 'masking' } }, copies: 0 });
    state.setMask(false);
    expect(session.getState()).toMatchObject({ mask: false, attempt: { kind: 'outcome', outcome: { kind: 'cleared', reason: 'masking' } } });
    unbind();
  });

  it('holds nothing of a completed summary after masking is turned on and off again with the panel closed', () => {
    const { state, session, unbind } = bound();
    session.setState({ ...session.getState(), draft: completed(), attempt: { kind: 'idle' }, copy: { kind: 'copied', copied: 1, notCopied: 0, alreadyCopied: false } });
    expect(heldText(session.getState())).toContain(SENTINEL);
    state.setMask(true);
    state.setMask(false);
    expect(heldText(session.getState())).not.toContain(SENTINEL);
    expect(session.getState()).toMatchObject({ draft: undefined, copy: { kind: 'idle' } });
    unbind();
  });

  it('is left to the panel while the panel is open', () => {
    const { state, session, unbind } = bound();
    state.presentation.setSummaryOpen(true);
    const before = session.getState();
    state.setMask(true);
    expect(session.getState()).toBe(before);
    unbind();
  });
});
