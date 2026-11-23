import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, GraphNode, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, REFUSE, type ReadRefsCall } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(cleanup);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const failed = <T,>(): ApiResult<T> => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'no', retryable: true, traceId: 'tr-1' } });
const ref = (id: string) => ({ sourceId: 'a', entityType: 'widget', stableId: id });
const node = (id: string, properties: { key: string; value?: unknown; masked?: boolean }[]): GraphNode => ({
  ref: ref(id),
  display: { title: id, type: 'widget' },
  properties: properties.map((property) => ({ key: property.key, value: property.value, dataClass: 'text', masked: property.masked ?? false })),
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: false },
});
const read = (nodes: GraphNode[], missing: string[] = []): ApiResult<ReadRefsResponse> => ok({ nodes, edges: [], missing: { entities: missing.map(ref), edges: [] } });
const bindingItem = (id: string, property: string, before = 'The holder is ', after = '.') => ({ state: 'segments' as const, segments: [{ literal: before }, { element: ref(id), property }, { literal: after }] });
const thread = (items: { item: ReturnType<typeof bindingItem> | { state: 'text'; text: string }; cites: ReturnType<typeof ref>[] }[]): AssistantThreadResponse => ({
  turns: [{ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: items.length, steps: 0, question: 'Who?', answer: { blocks: [{ kind: 'sentences', items }] } }],
  earlierTurns: 0,
  previousThreadClearedAt: null,
});
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
function open(response: AssistantThreadResponse, refs: ReadRefsCall) {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(response), false, refs);
  const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  render(h.tree());
  return { ...h, stop };
}

describe('the bound values of a stored answer, drawn from their elements under the current mask', () => {
  it('draws the value the gate returned, in the sentence, for the investigation source and without the mask when the switch is off', async () => {
    const h = open(thread([{ item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] }]), async () => read([node('A-1', [{ key: 'holder', value: 'Jordan Lee' }])]));
    expect(await screen.findByText(/The holder is Jordan Lee\./)).toBeTruthy();
    expect(h.askedRefs).toHaveLength(1);
    expect(h.askedRefs[0]).toMatchObject({ sourceId: 'a', entities: [ref('A-1')] });
    expect(h.askedRefs[0]).not.toHaveProperty('mask');
    h.stop();
  });

  it('draws a masked value as the gate returned it, and asks for the mask when the switch is on', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(thread([{ item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] }])), false, async () => read([node('A-1', [{ key: 'holder', value: 'J••• L•••', masked: true }])]));
    h.state.setMask(true);
    const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
    render(h.tree());
    expect(await screen.findByText(/The holder is J••• L•••\./)).toBeTruthy();
    expect(h.askedRefs[0]).toMatchObject({ mask: true });
    stop();
  });

  it('draws a value as unavailable when its element is missing, holds no such property, or holds a value of another kind, and the rest of the sentence still shows', async () => {
    const h = open(
      thread([
        { item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] },
        { item: bindingItem('A-2', 'holder', 'Second: ', ' end'), cites: [ref('A-2')] },
        { item: bindingItem('A-3', 'holder', 'Third: ', ' end'), cites: [ref('A-3')] },
        { item: bindingItem('A-4', 'holder', 'Fourth: ', ' end'), cites: [ref('A-4')] },
      ]),
      async () => read([node('A-2', [{ key: 'other', value: 'x' }]), node('A-3', [{ key: 'holder', value: { nested: true } }]), node('A-4', [{ key: 'holder', value: 'Ok' }])], ['A-1']),
    );
    expect(await screen.findByText(`The holder is ${ASSISTANT_COPY.valueUnavailable}.`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Second: ${ASSISTANT_COPY.valueUnavailable.replace(/[()]/g, '\\$&')} end`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`Third: ${ASSISTANT_COPY.valueUnavailable.replace(/[()]/g, '\\$&')} end`))).toBeTruthy();
    expect(screen.getByText(/Fourth: Ok end/)).toBeTruthy();
    h.stop();
  });

  it('shows a loading state while the read runs, and draws a table cell from its element', async () => {
    const wait = deferred<ApiResult<ReadRefsResponse>>();
    const response: AssistantThreadResponse = { turns: [{ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 1, steps: 0, answer: { blocks: [{ kind: 'table', columns: [{ state: 'text', text: 'Holder' }], rows: [{ cells: [{ state: 'segments', segments: [{ element: ref('A-1'), property: 'holder' }] }], cites: [ref('A-1')] }] }] } }], earlierTurns: 0, previousThreadClearedAt: null };
    const h = open(response, () => wait.promise);
    expect(await screen.findByText(ASSISTANT_COPY.valuesLoading)).toBeTruthy();
    await act(async () => wait.resolve(read([node('A-1', [{ key: 'holder', value: 'Maria Gomez' }])])));
    expect(within(await screen.findByRole('table')).getByText('Maria Gomez')).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.valuesLoading)).toBeNull();
    h.stop();
  });

  it('asks for each element once, in reads of at most 100, and keeps the values of the earlier reads when a later one fails, then reads only the failed one again', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `E-${index + 1}`);
    let fail = true;
    const h = open(thread(ids.map((id) => ({ item: bindingItem(id, 'holder', `${id}: `, ''), cites: [ref(id)] }))), async (request) => {
      const asked = request.entities.map((entity) => entity.stableId);
      if (asked.includes('E-101') && fail) return failed<ReadRefsResponse>();
      return read(asked.map((id) => node(id, [{ key: 'holder', value: `v-${id}` }])));
    });
    expect(await screen.findByText(ASSISTANT_COPY.valuesFailed)).toBeTruthy();
    expect(h.askedRefs.map((request) => request.entities.length).sort((a, b) => a - b)).toEqual([50, 100, 100]);
    expect(screen.getByText('E-1: v-E-1')).toBeTruthy();
    expect(screen.getByText('E-250: v-E-250')).toBeTruthy();
    expect(screen.getByText(`E-101: ${ASSISTANT_COPY.valueUnavailable}`)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain }));
    expect(await screen.findByText('E-101: v-E-101')).toBeTruthy();
    expect(h.askedRefs).toHaveLength(4);
    expect(h.askedRefs[3]?.entities.map((entity) => entity.stableId)).toEqual(ids.slice(100, 200));
    expect(screen.queryByText(ASSISTANT_COPY.valuesFailed)).toBeNull();
    h.stop();
  });

  it('drops a response that arrives after the masking changed, shows no value read under the old setting, and reads again under the new one', async () => {
    const wait = deferred<ApiResult<ReadRefsResponse>>();
    let calls = 0;
    const h = open(thread([{ item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] }]), (request) => {
      calls += 1;
      if (calls === 1) return wait.promise;
      return Promise.resolve(read([node('A-1', [{ key: 'holder', value: request.mask === true ? 'J••• L•••' : 'new-open', masked: request.mask === true }])]));
    });
    await screen.findByText(ASSISTANT_COPY.valuesLoading);
    act(() => h.state.setMask(true));
    await act(async () => wait.resolve(read([node('A-1', [{ key: 'holder', value: 'SENTINEL-OLD' }])])));
    expect(document.body.textContent).not.toContain('SENTINEL-OLD');
    expect(await screen.findByText(/The holder is J••• L•••\./)).toBeTruthy();
    expect(h.askedRefs.map((request) => request.mask === true)).toEqual([false, true]);
    expect(document.body.textContent).not.toContain('SENTINEL-OLD');
    h.stop();
  });

  it('leaves no value read under the old setting anywhere the panel holds it after the masking changes, when the new read fails and when the old response comes late (a leak scan with a canary)', async () => {
    const holders = (h: ReturnType<typeof open>): string => [document.body.innerHTML, JSON.stringify(h.session.store.getState()), JSON.stringify(h.session.stored.getState())].join('\n');
    let calls = 0;
    const first = open(thread([{ item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] }]), () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? read([node('A-1', [{ key: 'holder', value: 'SENTINEL-OPEN' }])]) : failed<ReadRefsResponse>());
    });
    expect(await screen.findByText(/SENTINEL-OPEN/)).toBeTruthy();
    // the canary: the scan finds the value while it is drawn
    expect(holders(first)).toContain('SENTINEL-OPEN');
    act(() => first.state.setMask(true));
    await screen.findByText(ASSISTANT_COPY.valuesFailed);
    expect(holders(first)).not.toContain('SENTINEL-OPEN');
    first.stop();
    cleanup();
    // the old response comes late, after the switch and after the new read failed
    const late = deferred<ApiResult<ReadRefsResponse>>();
    let again = 0;
    const second = open(thread([{ item: bindingItem('A-1', 'holder'), cites: [ref('A-1')] }]), () => {
      again += 1;
      return again === 1 ? late.promise : Promise.resolve(failed<ReadRefsResponse>());
    });
    await screen.findByText(ASSISTANT_COPY.valuesLoading);
    act(() => second.state.setMask(true));
    await screen.findByText(ASSISTANT_COPY.valuesFailed);
    await act(async () => late.resolve(read([node('A-1', [{ key: 'holder', value: 'SENTINEL-LATE' }])])));
    expect(holders(second)).not.toContain('SENTINEL-LATE');
    second.stop();
  });

  it('asks nothing for an answer with no bound value, nor for a reference of another source', async () => {
    const h = open(thread([{ item: { state: 'text', text: 'Plain text.' }, cites: [ref('A-1')] }]), async () => read([]));
    await screen.findByText('Plain text.');
    expect(h.askedRefs).toEqual([]);
    h.stop();
    cleanup();
    const other = open(thread([{ item: { state: 'segments', segments: [{ literal: 'x ' }, { element: { sourceId: 'elsewhere', entityType: 'widget', stableId: 'Z' }, property: 'holder' }] }, cites: [{ sourceId: 'elsewhere', entityType: 'widget', stableId: 'Z' }] }]), async () => read([]));
    expect(await screen.findByText(`x ${ASSISTANT_COPY.valueUnavailable}`)).toBeTruthy();
    expect(other.askedRefs).toEqual([]);
    other.stop();
  });
});
