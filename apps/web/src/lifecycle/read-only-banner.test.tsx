import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { sampleBanner } from '../banner/banner-fixtures.js';
import { answerOf, failure, flush, ID, renderLifecycle, shownState } from './harness.js';

const region = () => screen.queryByRole('region', { name: 'Request status' });

describe('the banner and the pill of a closed or archived investigation', () => {
  it('shows an open investigation with no banner and its save-state pill', () => {
    renderLifecycle(shownState('open'));
    expect(region()).toBeNull();
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('Unsaved');
  });

  it('shows a closed investigation with the pill, the chip, the headline, the line and Reopen', () => {
    renderLifecycle(shownState('closed'));
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Closed · read-only')).toBe(true);
    const banner = within(region() as HTMLElement);
    expect(banner.getByText('Closed')).toBeTruthy();
    expect(banner.getByText('This investigation is closed and read-only.')).toBeTruthy();
    expect(banner.getByText('Reopen it to make changes. Its named views and notes are kept.')).toBeTruthy();
    expect(banner.getByRole('button', { name: 'Reopen' })).toBeTruthy();
    expect(banner.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('shows an archived investigation with the pill, the chip, the headline and the line, and no action', () => {
    renderLifecycle(shownState('archived'));
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Archived · read-only')).toBe(true);
    const banner = within(region() as HTMLElement);
    expect(banner.getByText('Archived')).toBeTruthy();
    expect(banner.getByText('This investigation is archived and read-only.')).toBeTruthy();
    expect(banner.getByText('Archived investigations are hidden from the list by default.')).toBeTruthy();
    expect(banner.queryByRole('button')).toBeNull();
  });

  it('shows the standing banner again when a request banner that replaced it is dismissed', async () => {
    const { banner } = renderLifecycle(shownState('closed'));
    act(() => banner.show(sampleBanner({ id: 'request', headline: 'A request failed' })));
    expect(screen.getByText('A request failed')).toBeTruthy();
    expect(screen.queryByText('This investigation is closed and read-only.')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByText('This investigation is closed and read-only.')).toBeTruthy();
    act(() => banner.show(sampleBanner({ id: 'again' })));
    act(() => banner.clear());
    expect(screen.getByText('This investigation is closed and read-only.')).toBeTruthy();
  });

  it('announces the banner as a status and moves no focus', async () => {
    const state = shownState('open');
    const { banner } = renderLifecycle(state);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'closed', readOnly: true, version: 4, save: { kind: 'unsaved' } }));
    expect(document.activeElement).toBe(outside);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Closed. This investigation is closed and read-only.');
    expect(banner.view.getState().banner?.moveFocus).toBeUndefined();
    outside.remove();
  });

  it('takes the banner away when the investigation is reopened elsewhere and its record says open', () => {
    const state = shownState('closed');
    renderLifecycle(state);
    act(() => state.describeInvestigation({ title: 'T', caseRef: null, status: 'open', readOnly: false, version: 5, save: { kind: 'unsaved' } }));
    expect(region()).toBeNull();
  });
});

describe('Reopen on the banner', () => {
  it('sends open with the record version, then takes the banner and the Closed pill away and holds the answer', async () => {
    const changeInvestigationStatus = vi.fn(async () => answerOf('open', 5));
    const state = shownState('closed', 4);
    renderLifecycle(state, { changeInvestigationStatus });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
    await flush();
    expect(changeInvestigationStatus).toHaveBeenCalledWith(ID, 'open', 4);
    expect(region()).toBeNull();
    expect(state.investigation.getState().record).toMatchObject({ status: 'open', readOnly: false, version: 5 });
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Unsaved')).toBe(true);
    expect(screen.queryByText('Closed · read-only')).toBeNull();
  });

  it('is reached by Tab and works with Enter', async () => {
    const changeInvestigationStatus = vi.fn(async () => answerOf('open', 5));
    renderLifecycle(shownState('closed', 4), { changeInvestigationStatus });
    const user = userEvent.setup();
    const reopen = screen.getByRole('button', { name: 'Reopen' });
    for (let presses = 0; presses < 6 && document.activeElement !== reopen; presses += 1) await user.tab();
    expect(document.activeElement).toBe(reopen);
    await user.keyboard('{Enter}');
    await flush();
    expect(changeInvestigationStatus).toHaveBeenCalledTimes(1);
  });

  it('disables Reopen while the call is under way, and sends it once', async () => {
    let release: (value: ReturnType<typeof answerOf>) => void = () => undefined;
    const changeInvestigationStatus = vi.fn(() => new Promise<ReturnType<typeof answerOf>>((resolve) => (release = resolve)));
    renderLifecycle(shownState('closed', 4), { changeInvestigationStatus });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect((screen.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(changeInvestigationStatus).toHaveBeenCalledTimes(1);
    release(answerOf('open', 5));
    await flush();
    expect(region()).toBeNull();
  });

  it.each([
    ['CONFLICT', failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.')],
    ['NOT_FOUND', failure('NOT_FOUND', 'Not found.')],
    ['INTERNAL_ERROR', failure('INTERNAL_ERROR', 'Something went wrong. Quote the trace ID if you contact support.')],
  ])('shows the own message of a %s as a request banner, keeps the record and brings the standing banner back on Dismiss', async (_code, refused) => {
    const state = shownState('closed', 4);
    renderLifecycle(state, { changeInvestigationStatus: async () => ({ ok: false, failure: refused }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await flush();
    expect(screen.getByText('message' in refused ? refused.message : '')).toBeTruthy();
    expect(state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true, version: 4 });
    expect(screen.queryByText('This investigation is closed and read-only.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByText('This investigation is closed and read-only.')).toBeTruthy();
  });

  it('shows a network failure as a request banner and leaves the record', async () => {
    const state = shownState('closed', 4);
    renderLifecycle(state, { changeInvestigationStatus: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
    await flush();
    expect(screen.getByText('The request could not be sent. Try again.')).toBeTruthy();
    expect(state.investigation.getState().record?.status).toBe('closed');
  });

  it('offers Reload on a CONFLICT, which reads the investigation again and takes the new status', async () => {
    const getInvestigation = vi.fn(async () => ({ ok: true as const, value: { investigation: { id: ID, sourceId: 'demo', title: 'Renamed elsewhere', caseRef: null, status: 'open' as const, startingEntity: null, sourceState: 'available' as const, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 9 }, draft: { version: 1, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } }, notes: null, basedOnViewId: null }, save: { state: 'unsaved' as const, savedAt: null } } }));
    const state = shownState('closed', 4);
    renderLifecycle(state, { getInvestigation, changeInvestigationStatus: async () => ({ ok: false, failure: failure('CONFLICT', 'This item was changed elsewhere. Reload to continue.') }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await flush();
    expect(getInvestigation).toHaveBeenCalledWith(ID);
    expect(state.investigation.getState().record).toMatchObject({ title: 'Renamed elsewhere', status: 'open', readOnly: false, version: 9 });
    expect(region()).toBeNull();
  });
});
