import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DegreePreview, ExpandRequest, ExpandResponse, GraphEdge } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import type { RightClick } from '../canvas/scene.js';
import { createClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph, nodeKey, show, withBuiltIns } from './context-menu-kit.js';
import { ExpandProvider } from './expand-context.js';
import { FloatingPanels } from './panel-host.js';
import { createPanelRegistryFor, PanelsProvider } from './panel-registry.js';
import { PreviewProvider } from './preview-context.js';
import { bindSupernodePanel } from './supernode-panel-binder.js';

export interface Ask<T, R> {
  readonly body: T;
  readonly answer: (result: ApiResult<R>) => void;
}

export const count = (value: number | undefined, quality: 'exact' | 'lowerBound' | 'estimated' | 'unknown', scope = 'x') => (value === undefined ? { quality: 'unknown' as const, scope } : { value, quality, scope });

export const previewOf = (overrides: Partial<DegreePreview> = {}): DegreePreview => ({
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  total: count(3316, 'lowerBound'),
  byType: [
    { relationshipType: 'link-a', direction: 'out', count: count(12, 'exact'), neighborTypes: ['kind-b'] },
    { relationshipType: 'link-a', direction: 'in', count: count(3, 'exact'), neighborTypes: ['kind-b'] },
  ],
  byNeighborType: [
    { entityType: 'kind-b', count: count(15, 'exact') },
    { entityType: 'type-c', count: count(3300, 'lowerBound') },
    { entityType: 'type-d', count: count(undefined, 'unknown') },
  ],
  warnings: [],
  pageSize: 25,
  ...overrides,
});

export const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
export const relation = (id: string, from: string, to: string, toType = 'kind-b', relType = 'link-a'): GraphEdge => ({
  ref: edgeRef('a', id, relType, 'type-a', toType),
  from: ref('a', 'type-a', from),
  to: ref('a', toType, to),
  type: relType,
  direction: 'out',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});

export const response = (overrides: Partial<ExpandResponse> = {}): ExpandResponse => ({
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  pageSize: 25,
  nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b1')],
  edges: [relation('r1', 'n1', 'b1')],
  pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'x' } }],
  warnings: [],
  ...overrides,
});

export function panelRig(options: { readonly ids?: readonly string[] } = {}) {
  const previews: Ask<{ sourceId: string; ref: { entityType: string; stableId: string }; mask?: boolean }, DegreePreview>[] = [];
  const expansions: Ask<ExpandRequest, ExpandResponse>[] = [];
  const client = fakeClient({
    previewExpansion: (body) => new Promise((resolve) => void previews.push({ body, answer: resolve })),
    expandNeighbors: (body) => new Promise((resolve) => void expansions.push({ body, answer: resolve })),
  });
  const state = createClientState();
  loadGraph(state, (options.ids ?? ['n1', 'n2']).map((id) => node('a', id)), []);
  const previewStore = createPreviewStore(client, () => 'person-1');
  const expand = createExpandStore(client, state, () => 'person-1');
  const panels = createPanelRegistryFor(state);
  const unbind = bindSupernodePanel(state, panels);
  const menus = withBuiltIns();
  const shown = show(state, {}, menus, (
    <PanelsProvider registry={panels}>
      <FloatingPanels />
    </PanelsProvider>
  ), (tree) => (
    <PreviewProvider store={previewStore}>
      <ExpandProvider store={expand}>{tree}</ExpandProvider>
    </PreviewProvider>
  ));
  const rightClick = (id: string): void => shown.rightClick({ target: { kind: 'node', key: nodeKey(id) }, x: 50, y: 60 } satisfies RightClick);
  const open = async (id = 'n1'): Promise<void> => {
    rightClick(id);
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Expand by type' }));
    await act(async () => undefined);
  };
  return { state, panels, unbind, menus, previews, expansions, expand, rightClick, open, shown };
}

export const panel = () => screen.queryByRole('complementary', { name: 'Expand relationships' });
export const inPanel = () => within(screen.getByRole('complementary', { name: 'Expand relationships' }));
export const answerPreview = (ask: Ask<unknown, DegreePreview> | undefined, value: DegreePreview = previewOf()) => act(async () => ask?.answer({ ok: true, value }));
export const answerExpand = (ask: Ask<unknown, ExpandResponse> | undefined, value: ExpandResponse = response()) => act(async () => ask?.answer({ ok: true, value }));
export const failExpand = (ask: Ask<unknown, ExpandResponse> | undefined, code: string, details?: { maxPage: number }) =>
  act(async () => ask?.answer({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 'tr-9', ...(details === undefined ? {} : { details }) } } as never));
