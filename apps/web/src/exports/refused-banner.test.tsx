import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExportRecord } from '@neburyx/contracts';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { renderExport, shownState } from './harness.js';

const RECORD: ExportRecord = { id: '0192f000-0000-7000-8000-0000000000e1', status: 'ready', format: 'json', filename: 'x.json', sizeBytes: 1, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-17T10:15:00.000Z' };
const ok = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
const fail = (failure: ApiFailure): Promise<ApiResult<never>> => Promise.resolve({ ok: false, failure });
const denied = (reason?: 'access-changed'): ApiFailure => ({ code: 'ACCESS_DENIED', message: 'Your access changed since this export was made. Export again to get a file that matches your current access.', retryable: false, traceId: 't', ...(reason === undefined ? {} : { details: { reason } }) }) as ApiFailure;
const region = () => screen.queryByRole('region', { name: 'Request status' });

async function refused(failure: ApiFailure = denied('access-changed')) {
  const state = shownState('open');
  const rendered = renderExport(state, { createExport: () => ok(RECORD), downloadExport: () => fail(failure) });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Download JSON' }));
  return { ...rendered, user, state };
}

describe('the banner of a download refused because access changed', () => {
  it('closes the dialog and shows the chip, the sentence, and Export again, and never says what changed', async () => {
    await refused();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const banner = within(region() as HTMLElement);
    expect(banner.getByText('Export')).toBeTruthy();
    expect(banner.getByText('Your access changed since this export was made.')).toBeTruthy();
    expect(banner.getByText('Export again to get a file that matches your current access.')).toBeTruthy();
    expect(banner.getByRole('button', { name: 'Export again' })).toBeTruthy();
    expect(region()?.textContent ?? '').not.toMatch(/owner|policy|source|revoked|role/i);
  });

  it('opens the dialog with its defaults when Export again is chosen, and takes the banner away', async () => {
    const { user } = await refused();
    await user.click(within(region() as HTMLElement).getByRole('button', { name: 'Export again' }));
    const dialog = screen.getByRole('dialog', { name: 'Export current view' });
    expect((within(dialog).getByRole('radio', { name: 'JSON' }) as HTMLInputElement).checked).toBe(true);
    expect(region()).toBeNull();
  });

  it('leaves the loaded graph, filters and saved state as they were', async () => {
    const state = shownState('open');
    const graph = state.visibleGraph();
    const record = state.investigation.getState().record;
    const view = state.presentation.view.getState();
    renderExport(state, { createExport: () => ok(RECORD), downloadExport: () => fail(denied('access-changed')) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Download JSON' }));
    expect(state.visibleGraph()).toBe(graph);
    expect(state.investigation.getState().record).toEqual(record);
    expect(state.presentation.view.getState()).toBe(view);
  });

  it('replaces a standing banner and brings it back when it is dismissed', async () => {
    const state = shownState('closed');
    renderExport(state, { createExport: () => ok(RECORD), downloadExport: () => fail(denied('access-changed')) });
    const user = userEvent.setup();
    expect(screen.queryByText('Your access changed since this export was made.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Download JSON' }));
    expect(screen.getByText('Your access changed since this export was made.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Your access changed since this export was made.')).toBeNull();
  });

  it.each([
    ['EXPORT_FAILED', { code: 'EXPORT_FAILED', message: 'The export could not be created.', retryable: true, traceId: 't' } as ApiFailure],
    ['NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 't' } as ApiFailure],
    ['an ACCESS_DENIED that is not about a changed access', denied()],
  ])('shows no banner for %s, only the failure in the dialog', async (_name, failure) => {
    await refused(failure);
    expect(region()).toBeNull();
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe(failure.code === 'NETWORK_UNAVAILABLE' ? '' : (failure as { message: string }).message);
  });

  it('announces the banner on screen with the sentence the person must act on', async () => {
    const { banner } = await refused();
    await waitFor(() => expect(region()).not.toBeNull());
    expect(banner.view.getState().banner).toMatchObject({ id: 'export-download-refused', moveFocus: true, tone: 'warning' });
    expect(banner.view.getState().announcement?.text).toContain('Your access changed since this export was made.');
  });
});
