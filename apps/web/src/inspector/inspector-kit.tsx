import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { DegreePreview, DerivedNeighborsResponse, GraphNode, GraphProperty, SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createDerivedStore } from '../api/derived-store.js';
import { createPreviewStore } from '../api/preview-store.js';
import { ProfileProvider } from '../canvas/profile-context.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { node, ref } from '../state/test-data.js';
import { staticProfile } from '../test-utils.js';
import { loadGraph, show, withBuiltIns } from '../workspace/context-menu-kit.js';
import { FloatingPanels } from '../workspace/panel-host.js';
import { createPanelRegistryFor, PanelsProvider } from '../workspace/panel-registry.js';
import { DerivedProvider } from '../workspace/derived-context.js';
import { PreviewProvider } from '../workspace/preview-context.js';
import type { MenuRegistry } from '../workspace/menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider, type SelectionAction } from '../workspace/selection-actions.js';
import { bindLegend } from '../workspace/legend-binder.js';
import { bindBuiltInInspector } from './built-in-tabs.js';
import { createEntityReadStore, EntityReadProvider } from './entity-read.js';

export const TYPE = 'type-a';
export const keyOf = (id: string): string => elementKey(ref('a', TYPE, id));

export const property = (key: string, value: unknown, dataClass: GraphProperty['dataClass'] = 'text', masked = false): GraphProperty => ({ key, value, dataClass, masked });

export function entity(id: string, properties: readonly GraphProperty[] = [], overrides: Partial<GraphNode> = {}): GraphNode {
  return { ...node('a', id), display: { title: `Title ${id}`, type: TYPE }, properties: [...properties], ...overrides };
}

export function profileOf(keyProperties: readonly string[] = ['holder', 'opened'], stateProperty: string | null = 'status'): SourceProfile {
  const base = testProfile('a', [TYPE]);
  return { ...base, entityTypes: base.entityTypes.map((entry) => ({ ...entry, displayName: 'Kind A', keyProperties: [...keyProperties], stateProperty })) };
}

export interface Ask<R> {
  readonly answer: (result: ApiResult<R>) => void;
}

export const failure = (code: string, retryable = false): ApiFailure => ({ code, message: 'x', retryable, traceId: 'tr-1' }) as unknown as ApiFailure;

export interface RigOptions {
  readonly nodes?: readonly GraphNode[];
  readonly profile?: SourceProfile | undefined;
  readonly actions?: readonly SelectionAction[];
  readonly state?: ClientState;
  readonly menus?: MenuRegistry;
  /** The rules the profile lists; none by default, and then the inspector asks for no derived neighbors. */
  readonly derivedRules?: SourceProfile['derivedRules'];
}

/** The workspace with the inspector bound: a loaded graph, a profile, selection actions, and a client whose entity and preview reads wait for the test to answer. */
export function inspectorRig(options: RigOptions = {}) {
  const entityReads: Ask<GraphNode>[] = [];
  const entityCalls: Array<{ readonly id: string; readonly mask: boolean; readonly signal: AbortSignal | undefined }> = [];
  const previews: Ask<DegreePreview>[] = [];
  const derived: Ask<DerivedNeighborsResponse>[] = [];
  const derivedCalls: Array<{ readonly id: string; readonly mask: boolean; readonly signal: AbortSignal | undefined }> = [];
  const client: ApiClient = fakeClient({
    getEntity: (reference, opts, signal) => {
      entityCalls.push({ id: reference.stableId, mask: opts?.mask === true, signal });
      return new Promise((resolve) => void entityReads.push({ answer: resolve }));
    },
    previewExpansion: () => new Promise((resolve) => void previews.push({ answer: resolve })),
    derivedNeighbors: (request, signal) => {
      derivedCalls.push({ id: request.ref.stableId, mask: request.mask === true, signal });
      return new Promise((resolve) => void derived.push({ answer: resolve }));
    },
  });
  const state = options.state ?? createClientState();
  loadGraph(state, options.nodes ?? [entity('n1', [property('holder', 'Jordan')]), entity('n2')], []);
  const panels = createPanelRegistryFor(state);
  const unbindLegend = bindLegend(state, panels);
  const bound = bindBuiltInInspector(state, panels);
  const actions = createSelectionActionRegistry();
  for (const action of options.actions ?? []) actions.register(action);
  const reads = createEntityReadStore(client, () => 'person-1', () => state.investigation.getState().id ?? 'draft');
  const previewStore = createPreviewStore(client, () => 'person-1');
  const derivedStore = createDerivedStore(client, state, () => 'person-1', () => state.investigation.getState().id ?? 'draft');
  const base = 'profile' in options ? options.profile : profileOf();
  const profile = base === undefined ? base : { ...base, derivedRules: [...(options.derivedRules ?? [])] };
  const menus = options.menus ?? withBuiltIns();
  const shown = show(state, {}, menus, (
    <ProfileProvider store={staticProfile('a', profile)}>
      <PanelsProvider registry={panels}>
        <FloatingPanels />
      </PanelsProvider>
    </ProfileProvider>
  ), (tree: ReactNode) => (
    <SelectionActionsProvider registry={actions}>
      <PreviewProvider store={previewStore}>
        <DerivedProvider store={derivedStore}>
          <EntityReadProvider store={reads}>{tree}</EntityReadProvider>
        </DerivedProvider>
      </PreviewProvider>
    </SelectionActionsProvider>
  ));
  return { state, panels, menus, shown, client, previewStore, derivedStore, entityReads, entityCalls, previews, derived, derivedCalls, inspector: bound.inspector, unbind: () => (bound.unbind(), unbindLegend()) };
}

export const select = (state: ClientState, ...ids: string[]): void => void act(() => state.presentation.select(ids.map(keyOf)));
export const inspector = () => screen.queryByRole('complementary', { name: 'Inspector' });
export const inInspector = () => within(screen.getByRole('complementary', { name: 'Inspector' }));
export const answerEntity = (ask: Ask<GraphNode> | undefined, value: GraphNode) => act(async () => ask?.answer({ ok: true, value }));
export const failEntity = (ask: Ask<GraphNode> | undefined, code: string, retryable = false) => act(async () => ask?.answer({ ok: false, failure: failure(code, retryable) }));
export const count = (value: number | undefined, quality: 'exact' | 'lowerBound' | 'estimated' | 'unknown') => (value === undefined ? { quality: 'unknown' as const, scope: 'x' } : { value, quality, scope: 'x' });
export const spy = () => vi.fn<(selection: readonly string[]) => void | string>();
export { render };
