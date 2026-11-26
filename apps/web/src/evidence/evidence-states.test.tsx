import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { edgeKey } from '../state/keys.js';
import { answerEdge, detailOf, evidenceRig, failEdge, inPanel, openOn, OWNS, panel, SENT, selectEdge } from './evidence-kit.js';
import { NOT_AVAILABLE_BADGE } from './copy.js';
import { assertNoCodes } from '../patterns/no-codes.js';

afterEach(cleanup);

describe('the not-available state', () => {
  it('reads as an ordinary state in the frame words, with no alert or status role, and the other sub-tabs still work', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS, { observedAt: '2026-10-21T08:15:00Z', evidence: { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } }));
    expect(inPanel().getByText(NOT_AVAILABLE_BADGE)).toBeTruthy();
    expect(inPanel().getByText('Evidence not available')).toBeTruthy();
    expect(inPanel().getByText('The source holds no record for this relationship.')).toBeTruthy();
    expect(inPanel().queryByRole('alert')).toBeNull();
    expect(inPanel().queryByRole('status')).toBeNull();
    expect(inPanel().queryByText('Supporting source records:')).toBeNull();
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    expect(inPanel().getByText('21 Oct 2026, 08:15:00 UTC')).toBeTruthy();
    rig.unbind();
  });
});

describe('a read that fails', () => {
  it.each([
    ['SOURCE_BUSY', true, true, 'The source is busy. No read slot freed within the wait.'],
    ['RATE_LIMITED', true, true, 'Too many requests. Try again in a moment.'],
    ['QUERY_TIMEOUT', true, true, 'The source did not answer in time.'],
    ['SOURCE_UNAVAILABLE', true, true, 'The source did not answer. Try again shortly.'],
    ['NOT_FOUND', false, false, 'This was not found. It may have been removed.'],
    ['INTERNAL_ERROR', false, true, 'Something went wrong on the server. Try again; if it keeps happening, tell an administrator.'],
    ['INVALID_REQUEST', false, false, 'The server did not accept this request.'],
  ])('shows %s as the product shows it and leaves the canvas, selection and inspector as they were', async (code, retryable, offered, sentence) => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    const before = JSON.stringify([rig.state.loadedGraph(), [...rig.state.presentation.view.getState().selection]]);
    openOn(rig, OWNS);
    await failEdge(rig.edgeReads[0], code, retryable);
    expect(inPanel().getByRole('alert').textContent).toContain(sentence);
    assertNoCodes(inPanel().getByRole('alert').textContent);
    expect(inPanel().queryByRole('button', { name: 'Try again' }) !== null).toBe(offered);
    expect(JSON.stringify([rig.state.loadedGraph(), [...rig.state.presentation.view.getState().selection]])).toBe(before);
    rig.unbind();
  });

  it.each([
    ['NETWORK_UNAVAILABLE', 'The server could not be reached.'],
    ['UNREADABLE_RESPONSE', 'The answer could not be read.'],
    ['UNEXPECTED_FAILURE', 'Something went wrong.'],
    ['SCHEMA_MISMATCH', 'The answer was not in the form expected.'],
  ] as const)('shows the client failure %s', async (code, sentence) => {
    const rig = evidenceRig({ client: { getEdge: async () => ({ ok: false, failure: { code } }) } });
    openOn(rig, OWNS);
    await act(async () => undefined);
    expect(inPanel().getByRole('alert').textContent).toBe(sentence);
    expect(inPanel().queryByRole('button', { name: 'Try again' }) !== null).toBe(code !== 'SCHEMA_MISMATCH');
    rig.unbind();
  });

  it('shows nothing for a cancelled read', async () => {
    const rig = evidenceRig({ client: { getEdge: async () => ({ ok: false, failure: { code: 'ABORTED' } }) } });
    openOn(rig, OWNS);
    await act(async () => undefined);
    expect(screen.queryByRole('alert')).toBeNull();
    rig.unbind();
  });

  it('makes one new read on Try again and keeps the earlier message while it is on its way', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    await failEdge(rig.edgeReads[0], 'SOURCE_BUSY', true);
    await act(async () => inPanel().getByRole('button', { name: 'Try again' }).click());
    expect(rig.edgeCalls).toHaveLength(2);
    expect(inPanel().getByRole('alert').textContent).toContain('The source is busy. No read slot freed within the wait.');
    expect(inPanel().getByRole('status').textContent).toBe('Reading the evidence…');
    await answerEdge(rig.edgeReads[1], detailOf(OWNS));
    expect(inPanel().queryByRole('alert')).toBeNull();
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    rig.unbind();
  });

  it('aborts the read in flight when the panel closes or another relationship becomes the target, and drops its late failure', async () => {
    const rig = evidenceRig();
    selectEdge(rig, OWNS);
    openOn(rig, OWNS);
    const first = rig.edgeCalls[0];
    selectEdge(rig, SENT);
    expect(first?.signal?.aborted).toBe(true);
    await failEdge(rig.edgeReads[0], 'SOURCE_BUSY', true);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => rig.evidence.close());
    expect(rig.edgeCalls[1]?.signal?.aborted).toBe(true);
    expect(panel()).toBeNull();
    expect(edgeKey(SENT.ref)).toBeTruthy();
    rig.unbind();
  });
});
