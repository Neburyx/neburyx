import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeDetail } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { AGGREGATE_EVIDENCE_WAIT_MS, READ_WAIT_MS } from '../api/read-wait.js';
import { evidenceHit, searchAt, searchKit, withEvidence } from '../search/search-test-kit.js';
import { renderApp } from '../test-utils.js';
import { aggregateDetailOf, answerEdge, detailOf, evidenceRig, inPanel, openOn, OWNS, SUMMED } from './evidence-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const UNREACHABLE = 'The server could not be reached.';
const READING = 'Reading the evidence…';
const retry = () => inPanel().getByRole('button', { name: 'Try again' }) as HTMLButtonElement;

describe('relationship evidence whose read gets no answer', () => {
  it('ends the read of a stored relationship on the Search page at the bound, with Try again, which reads', async () => {
    const kit = searchKit(['demo'], async (request) => withEvidence(request.sourceId, [], [evidenceHit('L-1', { sourceId: request.sourceId })]));
    const asked: Array<(result: ApiResult<EdgeDetail>) => void> = [];
    renderApp(searchAt('demo', 'REC-1'), { ...kit.client, getEdge: () => new Promise<ApiResult<EdgeDetail>>((resolve) => void asked.push(resolve)) });
    for (let round = 0; round < 5; round += 1) await wait();
    await press(screen.getByRole('button', { name: 'View evidence: MADE_FROM L-1' }));
    await wait(READ_WAIT_MS - 1);
    expect(inPanel().getByRole('status').textContent).toBe(READING);
    expect(inPanel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(inPanel().getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(inPanel().queryByText(READING)).toBeNull();
    expect(retry().disabled).toBe(false);
    await press(retry());
    expect(asked).toHaveLength(2);
    const ref = { sourceId: 'demo', type: 'MADE_FROM', from: 'kind-a', to: 'kind-a', stableId: 'L-1' };
    const end = (id: string) => ({ ref: { sourceId: 'demo', entityType: 'kind-a', stableId: id }, title: id, type: 'kind-a' });
    await act(async () => asked[1]?.({ ok: true, value: { ref, type: 'MADE_FROM', semantics: 'stored', from: end('a'), to: end('b'), properties: [], qualityFlags: [], evidence: { status: 'available', records: [{ sourceRecordId: 'REC-1', linkable: false }] } } }));
    expect(within(screen.getByRole('complementary', { name: 'Relationship evidence' })).getByText('REC-1')).toBeTruthy();
    expect(inPanel().queryByRole('alert')).toBeNull();
  });

  it('ends the read of a stored relationship in Explore at the bound, with Try again, which reads', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    await wait(READ_WAIT_MS - 1);
    expect(inPanel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(inPanel().getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(retry().disabled).toBe(false);
    await press(retry());
    expect(rig.edgeCalls).toHaveLength(2);
    await answerEdge(rig.edgeReads[1], detailOf(OWNS));
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    expect(inPanel().queryByRole('alert')).toBeNull();
    rig.unbind();
  });

  it('ends the read of an aggregate relationship at the longer bound, with Try again, and takes the answer that then comes after the usual wait', async () => {
    const rig = evidenceRig();
    openOn(rig, SUMMED);
    await wait(AGGREGATE_EVIDENCE_WAIT_MS - 1);
    expect(inPanel().getByRole('status').textContent).toBe(READING);
    expect(inPanel().queryByRole('alert')).toBeNull();
    await wait(1);
    expect(inPanel().getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(retry().disabled).toBe(false);
    await press(retry());
    expect(rig.edgeCalls).toHaveLength(2);
    await wait(READ_WAIT_MS + 5000);
    expect(inPanel().getByRole('status').textContent).toBe(READING);
    await answerEdge(rig.edgeReads[1], aggregateDetailOf());
    expect(inPanel().queryByRole('alert')).toBeNull();
    expect(inPanel().queryByText(READING)).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Relationship evidence' }).textContent).toContain('42');
    rig.unbind();
  });
});
