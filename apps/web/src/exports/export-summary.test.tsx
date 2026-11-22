import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SUMMARY_TOKEN_LIFETIME_MS, type ExportRecord, type ExportRequest } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult, DownloadedFile } from '../api/client.js';
import { ID } from '../lifecycle/harness.js';
import { aiStatus, me } from '../test-utils.js';
import { createShellData, type ShellData } from '../shell/shell-data.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { createStore, type ReadableStore } from '../state/store.js';
import type { DraftResponse } from '../summary/summary-model.js';
import { createSummarySession, registerSummarySession, type SummaryDraft, type SummarySession } from '../summary/summary-session.js';
import { renderExport, shownState } from './harness.js';

const RECORD: ExportRecord = { id: '0192f000-0000-7000-8000-0000000000e1', status: 'ready', format: 'json', filename: 'neburyx-export-20261110T101500Z.json', sizeBytes: 12, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-13T10:15:00.000Z' };
const FILE: DownloadedFile = { blob: new Blob(['{}']), filename: RECORD.filename ?? '' };
const ok = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
const denied: ApiFailure = { code: 'ACCESS_DENIED', message: 'The AI case summary could not be included, so nothing was exported.', retryable: false, traceId: 'tr-1', details: { reason: 'summary-refused' } };
const revoked: ApiFailure = { code: 'ACCESS_DENIED', message: 'You do not have access to do this.', retryable: false, traceId: 'tr-1' };

const summaryStatus = (summary: 'available' | 'unavailable'): ReadableStore<ShellData> => {
  const store = createShellData({ getMe: () => ok(me()), getAiStatus: () => ok(aiStatus({ summary: summary === 'available' })), getSources: () => ok({ sources: [] }) } as never);
  return { getState: () => ({ ...store.getState(), me: { phase: 'ready', data: me() }, aiStatus: { phase: 'ready', data: aiStatus({ summary: summary === 'available' }) } }), subscribe: store.subscribe };
};

const response = { status: 'ok', sentences: [{ text: 'The record is listed.', cites: ['n1'], storable: false }], citations: [], coverage: { retrieval: 'r', summary: 's' }, removedCount: 0, sent: 'x', model: 'm', calls: 1, summaryToken: 'sealed-token' } as unknown as DraftResponse;

function draftOf(arrivedAt: number, over: Partial<SummaryDraft> = {}): SummaryDraft {
  return { response, entries: [], edits: new Map(), viewLine: 'line', arrivedAt, ...over };
}

function withDraft(draft: SummaryDraft | undefined, id: string = ID): { readonly state: ClientState; readonly session: SummarySession } {
  const state = shownState('open');
  const session = createSummarySession();
  session.setState({ ...session.getState(), investigationId: id, draft });
  registerSummarySession(state, session);
  return { state, session };
}

async function opened(state: ClientState, summary: 'available' | 'unavailable', calls: { created?: (request: ExportRequest) => Promise<ApiResult<unknown>> } = {}) {
  const requests: ExportRequest[] = [];
  const rendered = renderExport(
    state,
    {
      createExport: (_id, request) => {
        requests.push(request);
        return (calls.created?.(request) ?? ok(RECORD)) as never;
      },
      downloadExport: () => ok(FILE),
    },
    undefined,
    summaryStatus(summary),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  return { ...rendered, user, requests, box: within(screen.getByRole('dialog', { name: 'Export current view' })) };
}

afterEach(() => vi.useRealTimers());

describe('Include AI case summary in the Export dialog', () => {
  it('is offered, off, for an unedited draft that has not run out, and turning it on sends the token with a JSON or CSV export', async () => {
    const { state } = withDraft(draftOf(Date.now()));
    const { box, user, requests } = await opened(state, 'available');
    const option = box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement;
    expect(option.checked).toBe(false);
    expect(option.disabled).toBe(false);
    await user.click(option);
    await user.click(box.getByRole('button', { name: 'Download JSON' }));
    expect(requests[0]).toMatchObject({ format: 'json', summaryToken: 'sealed-token' });
  });

  it('sends no token when the option is off, for each format', async () => {
    const { state } = withDraft(draftOf(Date.now()));
    const { box, user, requests } = await opened(state, 'available');
    await user.click(box.getByRole('button', { name: 'Download JSON' }));
    expect(requests[0]).not.toHaveProperty('summaryToken');
  });

  it('is disabled with its reason when there is no draft, the draft is for another investigation, it is edited, it has run out, or the format is a picture, and sends nothing', async () => {
    const cases: readonly [string, () => { readonly state: ClientState }, string][] = [
      ['no draft', () => withDraft(undefined), 'Draft a summary first'],
      ['another investigation', () => withDraft(draftOf(Date.now()), 'another'), 'Draft a summary first'],
      ['an edited draft', () => withDraft(draftOf(Date.now(), { edits: new Map([[0, 'Changed text.']]) })), "Edited text can't be exported with the summary"],
      ['a draft that ran out', () => withDraft(draftOf(Date.now() - SUMMARY_TOKEN_LIFETIME_MS - 1000)), 'The draft has expired'],
    ];
    for (const [name, make, reason] of cases) {
      const { state } = make();
      const { box, user, requests } = await opened(state, 'available');
      const option = box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement;
      expect(option.disabled, name).toBe(true);
      expect(box.getByText(reason), name).toBeTruthy();
      expect(option.getAttribute('aria-describedby'), name).toBe(box.getByText(reason).id);
      await user.click(box.getByRole('button', { name: 'Download JSON' }));
      expect(requests[0], name).not.toHaveProperty('summaryToken');
      cleanup();
    }
    const { state } = withDraft(draftOf(Date.now()));
    const { box, user } = await opened(state, 'available');
    await user.click(box.getByRole('checkbox', { name: 'Include AI case summary' }));
    await user.click(box.getByRole('radio', { name: 'PNG' }));
    expect((box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement).disabled).toBe(true);
    expect(box.getByText('Not for a picture')).toBeTruthy();
  });

  it('shows the option locked, with the reason, when the summary is not available, and sends no token', async () => {
    const { state } = withDraft(draftOf(Date.now()));
    const { box, user, requests } = await opened(state, 'unavailable');
    const option = box.getByRole('checkbox', { name: 'Include AI case summary' });
    expect(option).toHaveProperty('disabled', true);
    expect(option).toHaveProperty('checked', false);
    expect(box.getByText('Not available: AI is switched off, or no AI provider is configured.')).toBeTruthy();
    expect(option.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(box.getByRole('button', { name: 'Download JSON' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).not.toHaveProperty('summaryToken');
  });

  it('says when the server refuses the token that nothing was exported, turns the option off and exports without it on the next try', async () => {
    const { state } = withDraft(draftOf(Date.now()));
    let attempt = 0;
    const { box, user, requests } = await opened(state, 'available', { created: () => (attempt++ === 0 ? Promise.resolve({ ok: false, failure: denied }) : ok(RECORD)) });
    await user.click(box.getByRole('checkbox', { name: 'Include AI case summary' }));
    await user.click(box.getByRole('button', { name: 'Download JSON' }));
    expect(await box.findByText('The summary could not be included, so nothing was exported. You can export without it.')).toBeTruthy();
    expect((box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement).checked).toBe(false);
    await user.click(box.getByRole('button', { name: 'Try again' }));
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty('summaryToken');
  });

  it('does not blame the summary for a refusal of access that has no such reason, and keeps the option as it was', async () => {
    const { state } = withDraft(draftOf(Date.now()));
    const { box, user } = await opened(state, 'available', { created: () => Promise.resolve({ ok: false, failure: revoked }) });
    await user.click(box.getByRole('checkbox', { name: 'Include AI case summary' }));
    await user.click(box.getByRole('button', { name: 'Download JSON' }));
    expect(await box.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(box.queryByText('The summary could not be included, so nothing was exported. You can export without it.')).toBeNull();
    expect((box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement).checked).toBe(true);
  });

  it('turns the option off at the moment the token runs out while the dialog is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = withDraft(draftOf(Date.now() - SUMMARY_TOKEN_LIFETIME_MS + 2000));
    const { box } = await opened(state, 'available');
    expect((box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement).disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect((box.getByRole('checkbox', { name: 'Include AI case summary' }) as HTMLInputElement).disabled).toBe(true);
    expect(box.getByText('The draft has expired')).toBeTruthy();
  });
});
