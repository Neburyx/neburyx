import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DegreePreview, ExpandRequest, ExpandResponse, GraphEdge } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import type { RightClick } from '../canvas/scene.js';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph, nodeKey, show } from './context-menu-kit.js';
import { ExpandProvider } from './expand-context.js';
import { MENU_GROUP, MENU_ORDER, createMenuRegistry } from './menu-registry.js';
import { PreviewProvider } from './preview-context.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';

afterEach(() => cleanup());

const count = (value: number | undefined, quality: 'exact' | 'lowerBound' | 'unknown', scope = 'x') => (value === undefined ? { quality: 'unknown' as const, scope } : { value, quality, scope });
const previewOf = (overrides: Partial<DegreePreview> = {}): DegreePreview => ({
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  total: count(512, 'lowerBound'),
  byType: [],
  byNeighborType: [
    { entityType: 'kind-b', count: count(12, 'exact') },
    { entityType: 'type-c', count: count(500, 'lowerBound') },
    { entityType: 'type-d', count: count(undefined, 'unknown') },
  ],
  warnings: [],
  pageSize: 25,
  ...overrides,
});

const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
const relation = (id: string, from: string, to: string, flags: string[] = []): GraphEdge => ({
  ref: edgeRef('a', id, 'link-a', 'type-a', 'kind-b'),
  from: ref('a', 'type-a', from),
  to: ref('a', 'kind-b', to),
  type: 'link-a',
  direction: 'out',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: flags,
});

interface Ask<T, R> {
  readonly body: T;
  readonly answer: (result: ApiResult<R>) => void;
}

function opened(options: { readonly open?: boolean; readonly ids?: readonly string[] } = {}) {
  const previews: Ask<{ sourceId: string; ref: { entityType: string; stableId: string }; mask?: boolean }, DegreePreview>[] = [];
  const expansions: Ask<ExpandRequest, ExpandResponse>[] = [];
  const client = fakeClient({
    previewExpansion: (body) => new Promise((resolve) => void previews.push({ body, answer: resolve })),
    expandNeighbors: (body) => new Promise((resolve) => void expansions.push({ body, answer: resolve })),
  });
  const state = createClientState();
  loadGraph(state, (options.ids ?? ['n1', 'n2']).map((id) => node('a', id)), []);
  const store = createPreviewStore(client, () => 'person-1');
  const expand = createExpandStore(client, state, () => 'person-1');
  const view = show(state, {}, undefined, null, (tree) => (
    <PreviewProvider store={store}>
      <ExpandProvider store={expand}>{tree}</ExpandProvider>
    </PreviewProvider>
  ));
  const rightClick = (target: string): RightClick => ({ target: { kind: 'node', key: nodeKey(target) }, x: 50, y: 60 });
  if (options.open !== false) view.rightClick(rightClick('n1'));
  return { previews, expansions, state, expand, view, rightClick };
}

const menu = (id = 'n1') => within(screen.getByRole('menu', { name: id }));
const byTypeRow = () => menu().getByRole('menuitem', { name: 'Expand by neighbor type' });
const submenu = () => screen.getByRole('group', { name: 'Expand by neighbor type' });
const checkbox = (name: string) => within(submenu()).getByRole('checkbox', { name: new RegExp(`^${name}`) });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const answerPreview = (ask: Ask<unknown, DegreePreview> | undefined, value: DegreePreview = previewOf()) => act(async () => ask?.answer({ ok: true, value }));
const response = (overrides: Partial<ExpandResponse> = {}): ExpandResponse => ({
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  pageSize: 25,
  nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b1')],
  edges: [relation('r1', 'n1', 'b1')],
  pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'x' } }],
  warnings: [],
  ...overrides,
});

describe('the Expand neighbors and Expand by neighbor type entries of the node menu', () => {
  it('registers Expand neighbors as a command with the E key and Expand by neighbor type with a submenu, in the expand group', () => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    const items = registry.view.getState().get('node') ?? [];
    expect(items.find((entry) => entry.id === 'expand-neighbors')).toMatchObject({ label: 'Expand neighbors', group: MENU_GROUP.node.expand, order: MENU_ORDER.node.expandNeighbors, binding: 'expand' });
    expect(items.find((entry) => entry.id === 'expand-neighbors')?.submenu).toBeUndefined();
    expect(items.find((entry) => entry.id === 'expand-by-neighbor-type')).toMatchObject({ label: 'Expand by neighbor type', group: MENU_GROUP.node.expand, order: MENU_ORDER.node.expandByNeighborType });
    expect(items.find((entry) => entry.id === 'expand-by-neighbor-type')?.submenu).toBeDefined();
  });

  it('asks nothing until Expand by neighbor type is opened, then asks once for the preview of the node, without the mask flag', async () => {
    const { previews } = opened();
    expect(previews).toHaveLength(0);
    await userEvent.setup().click(byTypeRow());
    expect(previews).toHaveLength(1);
    expect(previews[0]?.body).toEqual({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' } });
  });

  it('asks for the preview of the current masking setting, with the mask flag when the session masks', async () => {
    const { previews, state, view, rightClick } = opened({ open: false });
    state.setMask(true);
    view.rightClick(rightClick('n1'));
    await userEvent.setup().click(byTypeRow());
    expect(previews).toHaveLength(1);
    expect(previews[0]?.body).toMatchObject({ mask: true });
  });

  it('names and sends the page size the person set elsewhere, not the last answered one', async () => {
    const { previews, expansions, expand } = opened();
    expand.setPageSize(ref('a', 'type-a', 'n1'), 10);
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0]);
    expect(screen.getByText('Counts show their quality. Loads the first 10 per type.')).not.toBeNull();
    await userEvent.setup().click(within(submenu()).getByRole('button', { name: 'Expand 3 neighbors' }));
    expect(expansions[0]?.body.limit).toBe(10);
  });

  it('shows the heading, the note with the page size, one ticked row for each neighbor type with its count and quality, and the button with the number of ticked types', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0]);
    expect(within(submenu()).getByText('Counts show their quality. Loads the first 25 per type.')).not.toBeNull();
    expect(within(submenu()).getAllByRole('checkbox').map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([
      ['kind-b12 · exact', 'true'],
      ['type-c≥ 500 · lower bound', 'true'],
      ['type-dno count', 'true'],
    ]);
    expect(within(submenu()).getByRole('button', { name: 'Expand 3 neighbors' })).not.toBeNull();
  });

  it('changes the ticks with Clear, Select all and Invert selection, and disables the button when none is ticked', async () => {
    const { previews } = opened();
    const user = userEvent.setup();
    await user.click(byTypeRow());
    await answerPreview(previews[0]);
    await user.click(within(submenu()).getByRole('button', { name: 'Clear' }));
    expect(within(submenu()).getAllByRole('checkbox').every((row) => row.getAttribute('aria-checked') === 'false')).toBe(true);
    expect((within(submenu()).getByRole('button', { name: 'Expand 0 neighbors' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(checkbox('type-c'));
    await user.click(within(submenu()).getByRole('button', { name: 'Invert selection' }));
    expect(within(submenu()).getAllByRole('checkbox').map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
    expect(within(submenu()).getByRole('button', { name: 'Expand 2 neighbors' })).not.toBeNull();
    await user.click(within(submenu()).getByRole('button', { name: 'Select all' }));
    expect(within(submenu()).getByRole('button', { name: 'Expand 3 neighbors' })).not.toBeNull();
  });

  it('says more can be loaded page by page on a row whose count is a bound or unknown, and not on an exact one', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0]);
    expect(within(submenu()).getAllByText('More can be loaded page by page.')).toHaveLength(2);
  });

  it('keeps a type whose count is unknown or a lower bound tickable', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0]);
    expect((checkbox('type-d') as HTMLButtonElement).disabled).toBe(false);
    expect((checkbox('type-c') as HTMLButtonElement).disabled).toBe(false);
  });

  it('toggles a row with Space and Enter and returns the focus to the entry on Escape', async () => {
    const { previews } = opened();
    const user = userEvent.setup();
    byTypeRow().focus();
    await user.keyboard('{Enter}');
    await answerPreview(previews[0]);
    checkbox('kind-b').focus();
    await user.keyboard(' ');
    expect(checkbox('kind-b').getAttribute('aria-checked')).toBe('false');
    await user.keyboard('{Enter}');
    expect(checkbox('kind-b').getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(byTypeRow());
  });

  it('loads the first page of each ticked type with one request, adds the answer to the graph, selects what was added and closes the menu', async () => {
    const { previews, expansions, state } = opened();
    const user = userEvent.setup();
    await user.click(byTypeRow());
    await answerPreview(previews[0]);
    await user.click(checkbox('type-c'));
    await user.click(checkbox('type-d'));
    await user.click(within(submenu()).getByRole('button', { name: 'Expand 1 neighbor' }));
    expect(expansions).toHaveLength(1);
    expect(expansions[0]?.body).toEqual({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' }, neighborTypes: ['kind-b'], direction: 'both' });
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => expansions[0]?.answer({ ok: true, value: response() }));
    expect(state.loadedGraph().nodes.map((entry) => entry.ref.stableId).sort()).toEqual(['b1', 'n1', 'n2']);
    expect(state.loadedGraph().edges).toHaveLength(1);
    expect([...state.presentation.view.getState().selection].sort()).toEqual([edgeKey(relation('r1', 'n1', 'b1').ref), elementKey(ref('a', 'kind-b', 'b1'))].sort());
  });

  it('expands every mapped neighbor type with the Expand neighbors command, by mouse and by keyboard, without a preview', async () => {
    const { previews, expansions } = opened();
    const user = userEvent.setup();
    await user.click(menu().getByRole('menuitem', { name: 'Expand neighbors' }));
    expect(previews).toHaveLength(0);
    expect(expansions).toHaveLength(1);
    expect(expansions[0]?.body.neighborTypes).toEqual(['kind-b']);
    const second = opened({ open: true });
    second.view.rightClick({ target: { kind: 'node', key: nodeKey('n1') }, x: 50, y: 60 });
    await settle();
    const rows = screen.getAllByRole('menuitem', { name: 'Expand neighbors' });
    rows.at(-1)?.focus();
    await user.keyboard('{Enter}');
    expect(second.expansions).toHaveLength(1);
  });

  it('shows the failure and Retry in the submenu when the expansion fails, and adds nothing', async () => {
    const { previews, expansions, state, view, rightClick } = opened();
    const user = userEvent.setup();
    await user.click(byTypeRow());
    await answerPreview(previews[0]);
    await user.click(within(submenu()).getByRole('button', { name: 'Expand 3 neighbors' }));
    await act(async () => expansions[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(state.loadedGraph().nodes).toHaveLength(2);
    view.rightClick(rightClick('n1'));
    await user.click(byTypeRow());
    expect(within(submenu()).getByRole('alert').textContent).toBe('QUERY_TIMEOUT · trace tr-1');
    await user.click(within(submenu()).getByRole('button', { name: 'Retry' }));
    expect(expansions).toHaveLength(2);
  });

  it('offers no Retry in the submenu when the expansion fails with an unavailable source that retrying cannot help', async () => {
    const { previews, expansions, view, rightClick } = opened();
    const user = userEvent.setup();
    await user.click(byTypeRow());
    await answerPreview(previews[0]);
    await user.click(within(submenu()).getByRole('button', { name: 'Expand 3 neighbors' }));
    await act(async () => expansions[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: false, traceId: 'tr-9', details: { reason: 'index-failed' } } }));
    view.rightClick(rightClick('n1'));
    await user.click(byTypeRow());
    expect(within(submenu()).getByRole('alert')).not.toBeNull();
    expect(within(submenu()).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('the states of the preview in Expand by type', () => {
  const zeroOf = (direction: 'out' | 'in', neighbor: string) => ({ relationshipType: 'link-a', direction, count: count(0, 'exact'), neighborTypes: [neighbor] });

  it('says the counts are zero when relationships are mapped and the node has none, and keeps the checklist', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0], previewOf({ total: count(0, 'exact'), byType: [zeroOf('out', 'kind-b'), zeroOf('in', 'type-c')], byNeighborType: [{ entityType: 'kind-b', count: count(0, 'exact') }, { entityType: 'type-c', count: count(0, 'exact') }] }));
    expect(within(submenu()).getByText('No relationships found for this item.')).not.toBeNull();
    expect(within(submenu()).queryByText('No relationships are mapped for this entity type.')).toBeNull();
    expect(within(submenu()).queryByRole('alert')).toBeNull();
    expect(within(submenu()).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('does not say the counts are zero when one count is unknown', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await answerPreview(previews[0], previewOf({ byType: [zeroOf('out', 'kind-b'), { relationshipType: 'link-b', direction: 'out', count: count(undefined, 'unknown'), neighborTypes: ['type-c'] }] }));
    expect(within(submenu()).queryByText('No relationships found for this item.')).toBeNull();
  });

  it('says the item is no longer in the source for a NOT_FOUND answer, with no Retry', async () => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await act(async () => previews[0]?.answer({ ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 'tr-4' } }));
    expect(within(submenu()).getByRole('alert').textContent).toBe('This item is no longer in the source.');
    expect(within(submenu()).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(submenu()).queryByText(/No relationships/)).toBeNull();
  });

  it.each([
    ['INTERNAL_ERROR', false, 'INTERNAL_ERROR'],
    ['SOURCE_UNAVAILABLE', true, 'The source did not answer. Try again shortly.'],
    ['SOURCE_BUSY', true, 'SOURCE_BUSY'],
  ] as const)('names a %s failure of the preview in its notice and offers Retry, never an empty node', async (code, retryable, text) => {
    const { previews } = opened();
    const user = userEvent.setup();
    await user.click(byTypeRow());
    await act(async () => previews[0]?.answer({ ok: false, failure: { code, message: 'x', retryable, traceId: 'tr-5' } }));
    expect(within(submenu()).getByRole('alert').textContent).toContain(text);
    await user.click(within(submenu()).getByRole('button', { name: 'Retry' }));
    expect(previews).toHaveLength(2);
    expect(within(submenu()).queryByText(/No relationships/)).toBeNull();
  });

  it.each([
    ['index-failed', 'A needed index failed, so the read was not run.'],
    ['authentication', 'The source refused the login. Ask an administrator.'],
  ] as const)('names an unavailable source by the sentence of its reason %s, with no Retry', async (reason, message) => {
    const { previews } = opened();
    await userEvent.setup().click(byTypeRow());
    await act(async () => previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message, retryable: false, traceId: 'tr-6', details: { reason } } }));
    expect(within(submenu()).getByRole('alert').textContent).toBe(`${message} · trace tr-6`);
    expect(within(submenu()).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(submenu()).queryByText(/No relationships/)).toBeNull();
  });
});

describe('what an expansion does to the loaded graph', () => {
  async function expanded() {
    const parts = opened({ open: false });
    const ref1 = ref('a', 'type-a', 'n1');
    void parts.expand.expand(ref1, ['kind-b']);
    return { ...parts, ref1 };
  }

  it('adds the answer once: a neighbor and a relationship that arrive again are not duplicated', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    await act(async () => expansions[0]?.answer({ ok: true, value: response() }));
    void expand.expand(ref1, ['kind-b']);
    await act(async () => expansions[1]?.answer({ ok: true, value: response() }));
    expect(state.loadedGraph().nodes).toHaveLength(3);
    expect(state.loadedGraph().edges).toHaveLength(1);
  });

  it('adds nothing when the request fails, and keeps what was on screen, the selection and the failure to retry', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    state.presentation.select([nodeKey('n2')]);
    await act(async () => expansions[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1' } }));
    expect(state.loadedGraph().nodes).toHaveLength(2);
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n2')]);
    expect(expand.of(ref1)).toMatchObject({ status: 'failed', failure: { code: 'QUERY_TIMEOUT' } });
    void expand.retry(ref1);
    expect(expansions).toHaveLength(2);
    await act(async () => expansions[1]?.answer({ ok: true, value: response() }));
    expect(state.loadedGraph().nodes).toHaveLength(3);
    expect(expand.of(ref1).status).toBe('idle');
  });

  it('drops an answer that arrives after the masking changed, and one that was overtaken by a newer ask', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    state.setMask(true);
    await act(async () => expansions[0]?.answer({ ok: true, value: response() }));
    expect(state.loadedGraph().nodes).toHaveLength(2);
    state.setMask(false);
    void expand.expand(ref1, ['kind-b']);
    void expand.expand(ref1, ['kind-b']);
    await act(async () => expansions[1]?.answer({ ok: true, value: response({ nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'old')], edges: [relation('old', 'n1', 'old')] }) }));
    expect(state.loadedGraph().nodes.some((entry) => entry.ref.stableId === 'old')).toBe(false);
    await act(async () => expansions[2]?.answer({ ok: true, value: response() }));
    expect(state.loadedGraph().nodes.some((entry) => entry.ref.stableId === 'b1')).toBe(true);
  });

  it('carries the mask flag, and forgets what it knew of a node when the masking changes', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    await act(async () => expansions[0]?.answer({ ok: true, value: response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.a.b', matchingTotal: { quality: 'unknown', scope: 'x' } }] }) }));
    expect(expand.of(ref1).types.get('kind-b')).toMatchObject({ hasMore: true, cursor: 'v1.a.b', loaded: 1 });
    state.setMask(true);
    expect(expand.of(ref1).types.size).toBe(0);
    void expand.expand(ref1, ['kind-b']);
    expect(expansions[1]?.body.mask).toBe(true);
  });

  it('loads the next page of one type with its cursor alone, counts what is loaded, and stops offering more on the last page', async () => {
    const { expansions, expand, ref1 } = await expanded();
    const page = (more: boolean, cursor?: string) => response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: more, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    await act(async () => expansions[0]?.answer({ ok: true, value: page(true, 'v1.first.mac') }));
    void expand.loadMore(ref1, 'kind-b');
    expect(expansions[1]?.body).toMatchObject({ neighborTypes: ['kind-b'], cursors: { 'kind-b': 'v1.first.mac' } });
    await act(async () => expansions[1]?.answer({ ok: true, value: response({ nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b2')], edges: [relation('r2', 'n1', 'b2')], pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { quality: 'unknown', scope: 'x' } }] }) }));
    expect(expand.of(ref1).types.get('kind-b')).toMatchObject({ loaded: 2, hasMore: false });
  });

  it('flags a relationship that a later page of the same chain returns again, pages 1 and 3 included, and keeps it where it was', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    const page = (id: string, cursor: string | undefined, edge: GraphEdge) =>
      response({ nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', id)], edges: [edge], pages: [{ neighborType: 'kind-b', returned: 1, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    await act(async () => expansions[0]?.answer({ ok: true, value: page('b1', 'v1.one.mac', relation('r1', 'n1', 'b1')) }));
    void expand.loadMore(ref1, 'kind-b');
    await act(async () => expansions[1]?.answer({ ok: true, value: page('b2', 'v1.two.mac', relation('r2', 'n1', 'b2')) }));
    void expand.loadMore(ref1, 'kind-b');
    await act(async () => expansions[2]?.answer({ ok: true, value: page('b1', undefined, relation('r1', 'n1', 'b1')) }));
    expect(expand.of(ref1).duplicates).toBe(true);
    expect(state.loadedGraph().edges.filter((entry) => entry.qualityFlags.includes('conflicting-duplicate'))).toHaveLength(1);
    expect(state.loadedGraph().edges).toHaveLength(2);
  });

  it('does not flag a relationship that a second expansion of the node returns again, because it is a re-read', async () => {
    const { expansions, expand, ref1 } = await expanded();
    await act(async () => expansions[0]?.answer({ ok: true, value: response() }));
    void expand.expand(ref1, ['kind-b']);
    await act(async () => expansions[1]?.answer({ ok: true, value: response() }));
    expect(expand.of(ref1).duplicates).toBe(false);
  });

  it('flags a relationship the server flagged', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    await act(async () => expansions[0]?.answer({ ok: true, value: response({ edges: [relation('r1', 'n1', 'b1', ['conflicting-duplicate'])] }) }));
    expect(expand.of(ref1).duplicates).toBe(true);
    expect(state.loadedGraph().edges[0]?.qualityFlags).toContain('conflicting-duplicate');
  });

  it('keeps the chain it had when a first page fails, so a later page still flags a repeat', async () => {
    const { expansions, expand, ref1 } = await expanded();
    const page = (cursor: string | undefined) => response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    await act(async () => expansions[0]?.answer({ ok: true, value: page('v1.one.mac') }));
    void expand.expand(ref1, ['kind-b']);
    await act(async () => expansions[1]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-5' } }));
    void expand.loadMore(ref1, 'kind-b');
    await act(async () => expansions[2]?.answer({ ok: true, value: page(undefined) }));
    expect(expand.of(ref1).duplicates).toBe(true);
  });

  it('shows Retry after a failed restart, and not after a refused cursor', async () => {
    const { expansions, expand, ref1 } = await expanded();
    await act(async () => expansions[0]?.answer({ ok: true, value: response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }) }));
    void expand.loadMore(ref1, 'kind-b');
    await act(async () => expansions[1]?.answer({ ok: false, failure: { code: 'CURSOR_INVALIDATED', message: 'x', retryable: false, traceId: 'tr-6' } }));
    expect(expand.of(ref1)).toMatchObject({ failedAction: { kind: 'more' }, failure: { code: 'CURSOR_INVALIDATED' } });
    void expand.startOver(ref1, 'kind-b');
    await act(async () => expansions[2]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-7' } }));
    expect(expand.of(ref1)).toMatchObject({ failedAction: { kind: 'restart' }, failure: { code: 'QUERY_TIMEOUT' } });
  });

  it('restarts a type whose cursor was refused: no Retry, a new first page, nothing loaded is lost, and a repeat of the first page is not flagged', async () => {
    const { expansions, expand, state, ref1 } = await expanded();
    const first = response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.first.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] });
    await act(async () => expansions[0]?.answer({ ok: true, value: first }));
    void expand.loadMore(ref1, 'kind-b');
    await act(async () => expansions[1]?.answer({ ok: false, failure: { code: 'CURSOR_INVALIDATED', message: 'x', retryable: false, traceId: 'tr-2' } }));
    expect(expand.of(ref1).types.get('kind-b')?.restartNeeded).toBe(true);
    void expand.startOver(ref1, 'kind-b');
    expect(expansions[2]?.body.cursors).toBeUndefined();
    await act(async () => expansions[2]?.answer({ ok: true, value: first }));
    expect(state.loadedGraph().nodes).toHaveLength(3);
    expect(expand.of(ref1).duplicates).toBe(false);
    expect(expand.of(ref1).types.get('kind-b')).toMatchObject({ restartNeeded: false, hasMore: true });
  });
});
