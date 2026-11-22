import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ExportRecord, ExportRequest } from '@neburyx/contracts';
import type { ApiFailure, ApiResult, DownloadedFile } from '../api/client.js';
import { ID } from '../lifecycle/harness.js';
import { createClientState } from '../state/client-state.js';
import { newExportKey } from './export-attempt.js';
import { renderExport, shownState } from './harness.js';
import { profileOf } from '../inspector/inspector-kit.js';
import type { SourceProfile } from '@neburyx/contracts';
import { property } from '../inspector/inspector-kit.js';

const RECORD: ExportRecord = { id: '0192f000-0000-7000-8000-0000000000e1', status: 'ready', format: 'json', filename: 'neburyx-export-20261110T101500Z.json', sizeBytes: 12, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-17T10:15:00.000Z' };
const FILE: DownloadedFile = { blob: new Blob(['{}']), filename: RECORD.filename ?? '' };
const ok = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
const fail = (failure: ApiFailure): Promise<ApiResult<never>> => Promise.resolve({ ok: false, failure });
const server = (code: 'EXPORT_FAILED' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SOURCE_UNAVAILABLE' | 'INVALID_REQUEST', message: string, details?: object): ApiFailure => ({ code, message, retryable: false, traceId: 't', ...(details === undefined ? {} : { details }) }) as ApiFailure;

const dialog = () => screen.getByRole('dialog', { name: 'Export current view' });

async function opened(overrides = {}, state = shownState('open')) {
  const rendered = renderExport(state, overrides);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  return { ...rendered, user };
}

describe('the Export dialog', () => {
  it('shows the formats, the lines every export starts with, the footnote, Cancel and a Download button that follows the format', async () => {
    const { user } = await opened();
    const box = within(dialog());
    expect((box.getByRole('radio', { name: 'JSON' }) as HTMLInputElement).checked).toBe(true);
    expect(box.getByRole('radio', { name: 'CSV' })).toBeTruthy();
    expect(box.getByText('Every export starts with')).toBeTruthy();
    expect(box.getByText('source: demo')).toBeTruthy();
    expect(box.getByText(/^exported time: \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2} UTC$/)).toBeTruthy();
    expect(box.getByText('scope: current view (partial)')).toBeTruthy();
    expect(box.getByText(/^coverage: 1 shown · more not yet retrieved$/)).toBeTruthy();
    expect(box.getByText('masking: off')).toBeTruthy();
    expect(box.getByText('Exports are partial views, not signed evidence.')).toBeTruthy();
    expect(box.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await user.click(box.getByRole('radio', { name: 'CSV' }));
    expect(box.getByRole('button', { name: 'Download CSV' })).toBeTruthy();
    expect(box.getByRole('button', { name: 'Download CSV' })).toBeTruthy();
  });

  it('shows no send-to-store option', async () => {
    await opened();
    expect(dialog().textContent ?? '').not.toMatch(/configured store/i);
  });

  it('closes on Escape and gives the focus back to the Export button', async () => {
    const { user } = await opened();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export' }));
  });

  it('keeps the focus inside while open', async () => {
    const { user } = await opened();
    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('asks for the export with the references on screen and a new key, fetches the file, saves it under the server\'s name and closes', async () => {
    const requests: { id: string; body: ExportRequest; key: string }[] = [];
    const createExport = vi.fn((id: string, body: ExportRequest, key: string) => (requests.push({ id, body, key }), ok(RECORD)));
    const downloadExport = vi.fn(() => ok(FILE));
    const saved: DownloadedFile[] = [];
    const { user } = await opened({ createExport, downloadExport });
    const save = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ blob: new Blob(), filename: this.download }); });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createExport).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({ id: ID, body: { kind: 'view', format: 'json', entities: [{ sourceId: 'demo', entityType: 'type-a', stableId: 'A' }], edges: [], aggregates: [], derived: [] } });
    expect(requests[0]?.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(downloadExport).toHaveBeenCalledWith(RECORD.id);
    expect(saved.map((file) => file.filename)).toEqual([RECORD.filename]);
    expect(screen.getByRole('status', { name: '' })).toBeTruthy();
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Export downloaded.')).toBe(true);
    save.mockRestore();
    click.mockRestore();
  });

  it('shows a busy state while it works and makes one request for a double click', async () => {
    let finish: (value: ApiResult<ExportRecord>) => void = () => undefined;
    const createExport = vi.fn(() => new Promise<ApiResult<ExportRecord>>((resolve) => (finish = resolve)));
    const { user } = await opened({ createExport, downloadExport: () => ok(FILE) });
    const button = within(dialog()).getByRole('button', { name: 'Download JSON' });
    await user.dblClick(button);
    expect(createExport).toHaveBeenCalledTimes(1);
    const busy = within(dialog()).getByRole('button', { name: 'Preparing…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((within(dialog()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await act(async () => finish({ ok: true, value: RECORD }));
  });
});

describe('a failed export', () => {
  it('stays open with the server\'s message and Try again, saves nothing and leaves the canvas as it was', async () => {
    const state = shownState('open');
    const before = state.visibleGraph();
    const createExport = vi.fn(() => fail(server('EXPORT_FAILED', 'The export could not be created.')));
    const { user } = await opened({ createExport }, state);
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    expect(within(dialog()).getByRole('status').textContent).toBe('The export could not be created.');
    expect(within(dialog()).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(state.visibleGraph()).toBe(before);
  });

  it('names the limit when the view is too large', async () => {
    const createExport = vi.fn(() => fail(server('INVALID_REQUEST', 'This view holds more than one export can. Hide some items, then export again.', { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'aggregates' })));
    const { user } = await opened({ createExport });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    expect(within(dialog()).getByRole('status').textContent).toBe('This view holds more than one export can. Hide some items, then export again. An export holds at most 300 entities, 300 stored relationships and 100 aggregated or derived relationships.');
  });

  it.each([
    ['EXPORT_FAILED', 'keeps', server('EXPORT_FAILED', 'm')],
    ['INTERNAL_ERROR', 'keeps', server('INTERNAL_ERROR', 'm')],
    ['SOURCE_UNAVAILABLE', 'keeps', server('SOURCE_UNAVAILABLE', 'm')],
    ['a lost answer', 'keeps', { code: 'NETWORK_UNAVAILABLE' } as ApiFailure],
    ['RATE_LIMITED', 'changes', server('RATE_LIMITED', 'm')],
    ['INVALID_REQUEST', 'changes', server('INVALID_REQUEST', 'm')],
  ])('after %s, Try again %s the key', async (_name, rule, failure) => {
    const keys: string[] = [];
    const createExport = vi.fn((_id: string, _body: ExportRequest, key: string) => (keys.push(key), fail(failure)));
    const { user } = await opened({ createExport });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(keys).toHaveLength(2);
    expect(keys[0] === keys[1]).toBe(rule === 'keeps');
  });

  it('shows the failure of the file fetch in the dialog, and a fresh key for the next try', async () => {
    const keys: string[] = [];
    const createExport = vi.fn((_id: string, _body: ExportRequest, key: string) => (keys.push(key), ok(RECORD)));
    const downloadExport = vi.fn(() => fail(server('INTERNAL_ERROR', 'Something went wrong.')));
    const { user } = await opened({ createExport, downloadExport });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    expect(within(dialog()).getByRole('status').textContent).toBe('Something went wrong.');
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(keys[0] === keys[1]).toBe(false);
  });
});

describe('the Export button', () => {
  it.each(['closed', 'archived'] as const)('stays available for a %s investigation', (status) => {
    renderExport(shownState(status));
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is dimmed when no investigation is on screen', () => {
    renderExport(createClientState());
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses keys that fit the server\'s pattern', () => {
    expect(newExportKey()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

describe('the announcement of a failure', () => {
  it('has its polite region before the failure and receives the text once, in the same element', async () => {
    const createExport = vi.fn(() => fail(server('EXPORT_FAILED', 'The export could not be created.')));
    const { user } = await opened({ createExport });
    const region = within(dialog()).getByRole('status');
    expect(region.textContent).toBe('');
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    expect(within(dialog()).getByRole('status')).toBe(region);
    expect(region.textContent).toBe('The export could not be created.');
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(within(dialog()).getByRole('status')).toBe(region);
  });
});

describe('the other messages of the dialog', () => {
  it('shows the server sentence, not the busy one, for a conflict with a reason such as a changed source', async () => {
    const changed: ApiFailure = { code: 'CONFLICT', message: 'This source now points to a different database or is no longer configured. This investigation is read-only.', retryable: false, traceId: 't', details: { reason: 'source-changed', sourceState: 'repointed' } };
    const { user } = await opened({ createExport: () => fail(changed) });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    await waitFor(() => expect(within(dialog()).getByText(changed.message)).toBeTruthy());
    expect(dialog().textContent).not.toContain('already being made');
  });

  it('says the export is already being made when the server answers CONFLICT', async () => {
    const conflict: ApiFailure = { code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.', retryable: false, traceId: 't' };
    const { user } = await opened({ createExport: () => fail(conflict) });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    expect(within(dialog()).getByRole('status').textContent).toBe('This export is already being made. Try again in a moment.');
  });

  it('keeps the object URL until the browser has taken the file', async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { saveFile } = await import('./save-file.js');
    saveFile({ blob: new Blob(['x']), filename: 'a.json' });
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    vi.useRealTimers();
  });
});

const piiProfile = (pii: readonly string[]): SourceProfile => {
  const base = profileOf();
  const [first] = base.entityTypes;
  if (first === undefined) throw new Error('the profile has no entity type');
  return { ...base, entityTypes: [{ ...first, type: 'type-a', pii: [...pii] }] };
};

async function openedWith(options: { readonly state?: ReturnType<typeof shownState>; readonly overrides?: object; readonly profile?: SourceProfile } = {}) {
  const rendered = renderExport(options.state ?? shownState('open'), options.overrides ?? {}, undefined, undefined, options.profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  return { ...rendered, user };
}

const toggle = () => within(dialog()).getByRole('button', { name: 'Mask critical fields' });

describe('the Mask critical fields button', () => {
  it('is off by default for a file, with its hint, its state text and a plain preview and download', async () => {
    await openedWith({ profile: piiProfile(['holder']) });
    const box = within(dialog());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(box.getByText('Hides fields marked pii in neburyx.yaml (holder). Enterprise: fields your policy masks stay masked.')).toBeTruthy();
    expect(box.getByText('Off · exports include all values')).toBeTruthy();
    expect(box.getByText('masking: off')).toBeTruthy();
    expect(box.getByRole('button', { name: 'Download JSON' })).toBeTruthy();
  });

  it.each([['json', 'JSON'], ['csv', 'CSV']] as const)('turns on with Space, says how many fields the mapping marks pii, and sends mask true for %s', async (format, name) => {
    const requests: ExportRequest[] = [];
    const { user } = await openedWith({ profile: piiProfile(['holder', 'phone']), overrides: { createExport: (_id: string, body: ExportRequest) => (requests.push(body), ok(RECORD)), downloadExport: () => ok(FILE) } });
    const box = within(dialog());
    await user.click(box.getByRole('radio', { name }));
    toggle().focus();
    await user.keyboard(' ');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(box.getByText('On · 2 fields marked pii in this view')).toBeTruthy();
    expect(box.getByText('masking: on · the header states how many fields are masked')).toBeTruthy();
    await user.click(box.getByRole('button', { name: `Download ${name} (masked)` }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ format, mask: true });
  });

  it('sends no mask for a file when the button is off', async () => {
    const requests: ExportRequest[] = [];
    const { user } = await openedWith({ overrides: { createExport: (_id: string, body: ExportRequest) => (requests.push(body), ok(RECORD)), downloadExport: () => ok(FILE) } });
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).not.toHaveProperty('mask');
  });

  it.each([
    ['no profile yet', undefined, 'On'],
    ['no field marked pii', piiProfile([]), 'On · 0 fields marked pii in this view'],
    ['one field marked pii that no property holds', piiProfile(['holder']), 'On · 1 field marked pii in this view'],
  ] as const)('says only what it knows with %s', async (_name, profile, text) => {
    const { user } = await openedWith(profile === undefined ? {} : { profile });
    await user.click(toggle());
    expect(within(dialog()).getByText(text)).toBeTruthy();
  });

  it('is on and locked while the session switch is on, says why, and sends mask true', async () => {
    const requests: ExportRequest[] = [];
    const state = shownState('open');
    state.setMask(true);
    const { user } = await openedWith({ state, profile: piiProfile(['holder']), overrides: { createExport: (_id: string, body: ExportRequest) => (requests.push(body), ok(RECORD)), downloadExport: () => ok(FILE) } });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle()).toHaveProperty('disabled', true);
    expect(toggle().getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog()).getByText('Locked on while the view is masked')).toBeTruthy();
    expect(within(dialog()).queryByText('Off · exports include all values')).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON (masked)' }));
    await waitFor(() => expect(requests[0]).toMatchObject({ mask: true }));
  });

  it('is on and locked by a policy with the session switch off, and sends mask true', async () => {
    const requests: ExportRequest[] = [];
    const state = shownState('open');
    const policy = { ...property('holder', 'J••• L•••', 'name', true), maskedBy: 'policy' as const };
    const [first] = state.loadedGraph().nodes;
    if (first === undefined) throw new Error('no node');
    vi.spyOn(state, 'visibleGraph').mockReturnValue({ ...state.visibleGraph(), nodes: [{ ...first, properties: [policy] }] });
    const { user } = await openedWith({ state, overrides: { createExport: (_id: string, body: ExportRequest) => (requests.push(body), ok(RECORD)), downloadExport: () => ok(FILE) } });
    expect(state.mask.getState()).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle()).toHaveProperty('disabled', true);
    expect(within(dialog()).getByText('Locked on by your policy')).toBeTruthy();
    expect(within(dialog()).queryByText('Off · exports include all values')).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON (masked)' }));
    await waitFor(() => expect(requests[0]).toMatchObject({ mask: true }));
  });

  it('changes nothing outside the file: the session setting stays, nothing is read again, and the requests are the export and the download', async () => {
    const calls: string[] = [];
    const state = shownState('open');
    const { user } = await openedWith({ state, overrides: { createExport: () => (calls.push('create'), ok(RECORD)), downloadExport: () => (calls.push('download'), ok(FILE)), readRefs: () => (calls.push('read'), fail(server('INTERNAL_ERROR', 'x'))), getInvestigation: () => (calls.push('investigation'), fail(server('INTERNAL_ERROR', 'x'))) } });
    await user.click(toggle());
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON (masked)' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual(['create', 'download']);
    expect(state.mask.getState()).toBe(false);
  });

  it('keeps its state and the mask when the export fails and Try again is chosen', async () => {
    const requests: { body: ExportRequest; key: string }[] = [];
    let attempt = 0;
    const createExport = (_id: string, body: ExportRequest, key: string) => (requests.push({ body, key }), (attempt += 1) === 1 ? fail(server('SOURCE_UNAVAILABLE', 'The source is unavailable.')) : ok(RECORD));
    const { user } = await openedWith({ overrides: { createExport, downloadExport: () => ok(FILE) } });
    await user.click(toggle());
    await user.click(within(dialog()).getByRole('button', { name: 'Download JSON (masked)' }));
    const again = await within(dialog()).findByRole('button', { name: 'Try again' });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await user.click(again);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((request) => request.body)).toEqual([expect.objectContaining({ mask: true }), expect.objectContaining({ mask: true })]);
    expect(requests[1]?.key).toBe(requests[0]?.key);
  });

  it('is reached by Tab inside the dialog, is named by its text and keeps its name when on', async () => {
    const { user } = await openedWith();
    toggle().focus();
    expect(document.activeElement).toBe(toggle());
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Mask critical fields' }).getAttribute('aria-pressed')).toBe('true');
    expect(dialog().contains(toggle())).toBe(true);
  });

  it('is offered for a picture in every state, with the preview of a picture, and locked on while the session switch is on', async () => {
    const off = await openedWith();
    await off.user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(within(dialog()).getByText('masking: off')).toBeTruthy();
    await off.user.click(toggle());
    expect(within(dialog()).getByText('masking: on · the picture states how many fields are masked')).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Download PNG (masked)' })).toBeTruthy();
    cleanup();
    const state = shownState('open');
    state.setMask(true);
    const on = await openedWith({ state });
    await on.user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle()).toHaveProperty('disabled', true);
    expect(within(dialog()).getByText('Locked on while the view is masked')).toBeTruthy();
    expect(within(dialog()).getByText('masking: on · the picture states how many fields are masked')).toBeTruthy();
  });
});
