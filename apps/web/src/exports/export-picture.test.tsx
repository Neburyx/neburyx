import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import type { CreateExportResponse, ExportRequest } from '@neburyx/contracts';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { renderExport, shownState, type Capture, type Snapshot } from './harness.js';
import type { PictureCapture } from '../canvas/masked-picture.js';
import { node as plainNode } from '../state/test-data.js';
import { drawingBoundsFor } from './picture.js';

const composed = vi.hoisted(() => ({ compose: vi.fn() }));
vi.mock('./picture.js', async (original) => ({ ...(await original<typeof import('./picture.js')>()), composePicture: composed.compose }));

const LINES = ['source: demo', 'exported time: 10 Nov 2026, 10:15:00 UTC', 'scope: current view (partial)', 'coverage: 1 shown · ~38 not yet retrieved (estimated)', 'masking: off'];
const HEADER = { source: 'demo', exported: '2026-11-10T10:15:00.000Z', scope: 'current view (partial)' as const, coverage: { shown: 1, notRetrieved: { value: 38, quality: 'estimated' as const, scope: 'not yet retrieved' }, uncounted: 0 }, masking: 'off' as const, lines: LINES };
const ANSWER: CreateExportResponse = { format: 'png', filename: 'neburyx-export-20261110T101500Z.png', header: HEADER };
const DRAWING = new Blob(['drawing'], { type: 'image/png' });
const FINAL = new Blob(['final'], { type: 'image/png' });
const ok = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
const fail = (failure: ApiFailure): Promise<ApiResult<never>> => Promise.resolve({ ok: false, failure });
const refused: ApiFailure = { code: 'INVALID_REQUEST', message: 'Some items in this view are no longer available to you. Reload the view and try again.', retryable: false, traceId: 't', details: { reason: 'export-view-changed' } };

const dialog = () => screen.getByRole('dialog', { name: 'Export current view' });

async function openPng(overrides = {}, snapshot?: Snapshot, state = shownState('open')) {
  const rendered = renderExport(state, overrides, snapshot);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
  return { ...rendered, user };
}

beforeEach(() => {
  composed.compose.mockReset();
  composed.compose.mockResolvedValue(FINAL);
});

describe('the PNG option of the Export dialog', () => {
  it('offers PNG after JSON and CSV, keeps JSON as the default and the header preview, and names the button after it', async () => {
    renderExport(shownState('open'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const box = within(dialog());
    expect((box.getByRole('radio', { name: 'JSON' }) as HTMLInputElement).checked).toBe(true);
    expect(box.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['json', 'csv', 'png']);
    await user.click(box.getByRole('radio', { name: 'PNG' }));
    expect(box.getByRole('button', { name: 'Download PNG' })).toBeTruthy();
    expect(box.getByText('scope: current view (partial)')).toBeTruthy();
  });

  it('does not promise "masking: off" in the preview of a picture when the session masks', async () => {
    const state = shownState('open');
    state.setMask(true);
    await openPng({}, undefined, state);
    expect(within(dialog()).queryByText('masking: off')).toBeNull();
    expect(within(dialog()).getByText('masking: on · the picture states how many fields are masked')).toBeTruthy();
  });

  it('is chosen by the arrow keys over the formats', async () => {
    const user = userEvent.setup();
    renderExport(shownState('open'));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    within(dialog()).getByRole('radio', { name: 'JSON' }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect((within(dialog()).getByRole('radio', { name: 'PNG' }) as HTMLInputElement).checked).toBe(true);
  });

  it('takes the picture, asks for the header with the references of the view, draws the server\'s lines and saves under the server\'s name', async () => {
    const order: string[] = [];
    const snapshot = vi.fn<Snapshot>(() => {
      order.push('snapshot');
      return Promise.resolve(DRAWING);
    });
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => {
      order.push('request');
      return ok(ANSWER);
    });
    const downloadExport = vi.fn();
    const objects: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => (objects.push(object as Blob), 'blob:x'));
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    const { user, state } = await openPng({ createExport, downloadExport }, snapshot);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(order).toEqual(['snapshot', 'request']);
    expect(snapshot).toHaveBeenCalledWith(drawingBoundsFor());
    const request = createExport.mock.calls[0]?.[1];
    expect(request).toMatchObject({ kind: 'view', format: 'png', mask: false, entities: state.visibleGraph().nodes.map((node) => node.ref) });
    expect(composed.compose).toHaveBeenCalledWith(DRAWING, LINES);
    expect(downloadExport).not.toHaveBeenCalled();
    expect(saved).toEqual([ANSWER.filename]);
    expect(objects).toEqual([FINAL]);
  });

  it('sends the references of what the view shows, so an item filtered out is in neither the request nor the picture', async () => {
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => ok(ANSWER));
    const state = shownState('open');
    const shown = state.visibleGraph();
    vi.spyOn(state, 'visibleGraph').mockReturnValue({ ...shown, nodes: [], edges: [] });
    const { user } = await openPng({ createExport }, undefined, state);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(createExport).toHaveBeenCalled());
    expect(createExport.mock.calls[0]?.[1]).toMatchObject({ entities: [], edges: [], aggregates: [], derived: [] });
  });

  it.each([true, false])('sends the session\'s mask as it is (%s)', async (mask) => {
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => ok(ANSWER));
    const state = shownState('open');
    state.setMask(mask);
    const { user } = await openPng({ createExport }, undefined, state);
    await user.click(within(dialog()).getByRole('button', { name: mask ? 'Download PNG (masked)' : 'Download PNG' }));
    await waitFor(() => expect(createExport).toHaveBeenCalled());
    expect(createExport.mock.calls[0]?.[1]).toMatchObject({ mask });
  });

  it('keeps the moment Download was pressed when the view changes while the request is in flight', async () => {
    let answer: (value: ApiResult<CreateExportResponse>) => void = () => undefined;
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => new Promise<ApiResult<CreateExportResponse>>((resolve) => void (answer = resolve)));
    const state = shownState('open');
    const { user } = await openPng({ createExport }, undefined, state);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(createExport).toHaveBeenCalled());
    state.setMask(true);
    answer({ ok: true, value: ANSWER });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createExport.mock.calls[0]?.[1]).toMatchObject({ mask: false });
  });

  it('shows the server\'s sentence for a view that changed, offers Try again, downloads nothing and leaves the canvas alone', async () => {
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => fail(refused));
    const snapshot = vi.fn<Snapshot>(() => Promise.resolve(DRAWING));
    const { user } = await openPng({ createExport }, snapshot);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe(refused.message));
    expect(within(dialog()).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(composed.compose).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 'This investigation was not found.', false],
    ['QUERY_TIMEOUT', 'The source did not answer in time. Try again or refine your filters.', true],
  ] as const)('shows the server\'s sentence for %s', async (code, message, retryable) => {
    const failure: ApiFailure = { code, message, retryable, traceId: 't' };
    const { user } = await openPng({ createExport: () => fail(failure) });
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe(message));
    expect(composed.compose).not.toHaveBeenCalled();
  });

  it('says the export could not be made, sends no request and downloads nothing when the picture cannot be taken', async () => {
    const createExport = vi.fn();
    const snapshot = vi.fn<Snapshot>(() => Promise.reject(new Error('canvas too large')));
    const { user } = await openPng({ createExport }, snapshot);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('The export could not be made. Try again.'));
    expect(createExport).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says the export could not be made and sends the retry under a new key when the picture cannot be drawn', async () => {
    composed.compose.mockRejectedValueOnce(new Error('encode'));
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => ok(ANSWER));
    const { user } = await openPng({ createExport });
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('The export could not be made. Try again.'));
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createExport.mock.calls[1]?.[2]).not.toBe(createExport.mock.calls[0]?.[2]);
  });

  it('shows a busy state and makes one request for a double click', async () => {
    let answer: (value: ApiResult<CreateExportResponse>) => void = () => undefined;
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => new Promise<ApiResult<CreateExportResponse>>((resolve) => void (answer = resolve)));
    const { user } = await openPng({ createExport });
    const button = within(dialog()).getByRole('button', { name: 'Download PNG' });
    await user.dblClick(button);
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Preparing…' }).getAttribute('aria-busy')).toBe('true'));
    expect(createExport).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: ANSWER });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

const maskedNode = (id: string): GraphNode => ({ ...plainNode('demo', id), display: { title: 'J••• L•••', type: 'type-a' }, properties: [{ key: 'holder', value: 'J••• L•••', dataClass: 'name', masked: true, maskedBy: 'request' }] });
const maskedHeader = (maskedFields: number): CreateExportResponse => ({ ...ANSWER, header: { ...HEADER, masking: maskedFields === 0 ? 'off' : { maskedFields }, lines: [...LINES.slice(0, 4), `masking: ${maskedFields} critical fields masked`] } });
const readOf = (nodes: readonly GraphNode[], edges: readonly GraphEdge[] = [], missing = { entities: [] as never[], edges: [] as never[] }) => ok({ nodes: [...nodes], edges: [...edges], missing });
const APART = new Blob(['apart'], { type: 'image/png' });

async function openMasked(options: { readonly overrides?: object; readonly state?: ReturnType<typeof shownState>; readonly snapshot?: Snapshot; readonly draw?: PictureCapture['draw'] } = {}) {
  const state = options.state ?? shownState('open');
  const draw = vi.fn<PictureCapture['draw']>(options.draw ?? (() => Promise.resolve(APART)));
  const capture = vi.fn<Capture>(() => ({ graph: state.loadedGraph(), draw }));
  const snapshot = vi.fn<Snapshot>(options.snapshot ?? (() => Promise.resolve(DRAWING)));
  const rendered = renderExport(state, options.overrides ?? {}, snapshot, undefined, undefined, capture);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
  await user.click(within(dialog()).getByRole('button', { name: 'Mask critical fields' }));
  return { ...rendered, user, draw, capture, snapshot, state };
}

const download = (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole('button', { name: 'Download PNG (masked)' }));

describe('a picture exported with the button on and the session switch off', () => {
  it('is drawn from the items read again with the mask, at the places of the canvas, after the server has agreed, and never from the canvas as it is', async () => {
    const order: string[] = [];
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => (order.push('export'), ok(maskedHeader(1))));
    const readRefs = vi.fn((_request: unknown) => (order.push('read'), readOf([maskedNode('A')])));
    const { user, draw, capture, snapshot, state } = await openMasked({ overrides: { createExport, readRefs } });
    await download(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(order).toEqual(['export', 'read']);
    expect(createExport.mock.calls[0]?.[1]).toMatchObject({ format: 'png', mask: true });
    expect(readRefs.mock.calls[0]?.[0]).toMatchObject({ sourceId: 'demo', mask: true, entities: state.visibleGraph().nodes.map((node) => node.ref) });
    expect(snapshot).not.toHaveBeenCalled();
    const items = draw.mock.calls[0]?.[0];
    expect(capture).toHaveBeenCalledTimes(1);
    expect(items?.nodes.map((node) => node.properties[0]?.value)).toEqual(['J••• L•••']);
    expect(JSON.stringify(items?.nodes)).not.toContain('"title":"A"');
    expect(draw.mock.calls[0]?.[1]).toEqual(drawingBoundsFor());
    expect(composed.compose).toHaveBeenCalledWith(APART, expect.arrayContaining(['masking: 1 critical fields masked']));
    expect(state.mask.getState()).toBe(false);
  });

  it.each([
    ['a failing read', () => fail({ code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' })],
    ['an item that may not be exported', () => readOf([{ ...maskedNode('A'), authorization: { canInspect: true, canExport: false } }])],
    ['an item that did not come back', () => readOf([])],
    ['an item reported missing', () => readOf([maskedNode('A')], [], { entities: [{ sourceId: 'demo', entityType: 'type-a', stableId: 'A' }] as never[], edges: [] })],
    ['another number of masked fields than the header states', () => readOf([plainNode('demo', 'A')])],
  ])('draws nothing and says the export could not be made after %s, and the retry asks again under a new key', async (_name, read) => {
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => ok(maskedHeader(1)));
    const readRefs = vi.fn(() => read());
    const { user, draw } = await openMasked({ overrides: { createExport, readRefs } });
    await download(user);
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('The export could not be made. Try again.'));
    expect(draw).not.toHaveBeenCalled();
    expect(composed.compose).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(readRefs).toHaveBeenCalledTimes(2));
    expect(createExport.mock.calls[1]?.[2]).not.toBe(createExport.mock.calls[0]?.[2]);
  });

  it('is not drawn when the drawing cannot be made from the items', async () => {
    const { user } = await openMasked({ overrides: { createExport: () => ok(maskedHeader(1)), readRefs: () => readOf([maskedNode('A')]) }, draw: () => Promise.reject(new Error('an item has no counterpart')) });
    await download(user);
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toBe('The export could not be made. Try again.'));
    expect(composed.compose).not.toHaveBeenCalled();
  });

  it('reads nothing and draws nothing when the server refuses the export', async () => {
    const readRefs = vi.fn();
    const { user, draw, capture } = await openMasked({ overrides: { createExport: () => fail(refused), readRefs } });
    await download(user);
    await waitFor(() => expect(within(dialog()).getByRole('status').textContent).toContain('no longer available'));
    expect(readRefs).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    expect(composed.compose).not.toHaveBeenCalled();
  });

  it('is drawn from the view as it was when Download was pressed, though the view changes while the request is in flight', async () => {
    let answer: (value: ApiResult<CreateExportResponse>) => void = () => undefined;
    const createExport = vi.fn((_id: string, _request: ExportRequest, _key: string) => new Promise<ApiResult<CreateExportResponse>>((resolve) => void (answer = resolve)));
    const readRefs = vi.fn(() => readOf([maskedNode('A')]));
    const { user, draw, capture, state } = await openMasked({ overrides: { createExport, readRefs } });
    await download(user);
    await waitFor(() => expect(createExport).toHaveBeenCalled());
    expect(capture).toHaveBeenCalledTimes(1);
    const before = state.visibleGraph().nodes.map((node) => node.ref.stableId);
    state.setMask(true);
    answer({ ok: true, value: maskedHeader(1) });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createExport.mock.calls[0]?.[1]).toMatchObject({ mask: true, entities: [expect.objectContaining({ stableId: before[0] })] });
    expect(readRefs.mock.calls[0]).toEqual([expect.objectContaining({ mask: true, entities: [expect.objectContaining({ stableId: 'A' })] }), undefined]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(before).toEqual(['A']);
  });

  it('is locked on by a policy with the switch off: drawn from masked items too', async () => {
    const state = shownState('open');
    const [held] = state.loadedGraph().nodes;
    if (held === undefined) throw new Error('no node');
    const policy = { ...held, properties: [{ key: 'holder', value: 'J••• L•••', dataClass: 'name' as const, masked: true, maskedBy: 'policy' as const }, { key: 'phone', value: '+1 555 0100', dataClass: 'phone' as const, masked: false }] };
    vi.spyOn(state, 'visibleGraph').mockReturnValue({ ...state.visibleGraph(), nodes: [policy] });
    const readRefs = vi.fn(() => readOf([{ ...maskedNode('A'), properties: [{ key: 'holder', value: 'J••• L•••', dataClass: 'name' as const, masked: true, maskedBy: 'policy' as const }, { key: 'phone', value: '+1 •••••', dataClass: 'phone' as const, masked: true, maskedBy: 'request' as const }] }]));
    const draw = vi.fn<PictureCapture['draw']>(() => Promise.resolve(APART));
    renderExport(state, { createExport: () => ok(maskedHeader(2)), readRefs }, undefined, undefined, undefined, () => ({ graph: state.loadedGraph(), draw }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
    expect(within(dialog()).getByRole('button', { name: 'Mask critical fields' })).toHaveProperty('disabled', true);
    await user.click(within(dialog()).getByRole('button', { name: 'Download PNG (masked)' }));
    await waitFor(() => expect(draw).toHaveBeenCalled());
    expect(readRefs).toHaveBeenCalledWith(expect.objectContaining({ mask: true }), undefined);
    expect(JSON.stringify(draw.mock.calls[0]?.[0].nodes)).not.toContain('555 0100');
  });
});

describe('a picture exported with the session switch on or the button off', () => {
  it.each([[true], [false]])('is drawn from the canvas before the request, with no read of the items (switch %s)', async (switchOn) => {
    const state = shownState('open');
    state.setMask(switchOn);
    const readRefs = vi.fn();
    const capture = vi.fn<Capture>();
    const snapshot = vi.fn<Snapshot>(() => Promise.resolve(DRAWING));
    renderExport(state, { createExport: () => ok(maskedHeader(0)), readRefs }, snapshot, undefined, undefined, capture);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(within(dialog()).getByRole('radio', { name: 'PNG' }));
    await user.click(within(dialog()).getByRole('button', { name: switchOn ? 'Download PNG (masked)' : 'Download PNG' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(snapshot).toHaveBeenCalled();
    expect(readRefs).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
