import { type EdgeRef, type ElementRef, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { withoutReadsWhileSourceChanged } from '../api/changed-source-guard.js';
import { draftSyncOf, type DraftSync } from '../draft/draft-sync.js';
import { chunks } from '../draft/restore.js';
import { isUnmappedEdge, isUnmappedNode } from '../draft/unmapped.js';
import type { ClientState } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { restoreNoticeOf } from '../views/restore-notice.js';

type MaskRead = { readonly kind: 'idle' } | { readonly kind: 'reading' } | { readonly kind: 'failed'; readonly failure: ApiFailure };

export interface MaskSwitch {
  readonly status: ReadableStore<MaskRead>;
  /** Changes the masking setting and reads the items of the view again with it. */
  turn(mask: boolean): void;
  /** Reads again after a failure, with the setting as it is. */
  retry(): void;
}

interface Placeholders {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

const NO_PLACEHOLDERS: Placeholders = { nodes: [], edges: [] };

const STORED_EDGES = (refs: readonly EdgeRef[]) => refs.flatMap((ref) => ('stableId' in ref ? [ref] : []));
const AGGREGATE_EDGES = (refs: readonly EdgeRef[]) => refs.flatMap((ref) => ('aggregate' in ref ? [ref] : []));
const DERIVED_EDGES = (refs: readonly EdgeRef[]) => refs.flatMap((ref) => ('derived' in ref ? [ref] : []));

function createMaskSwitch(state: ClientState, client: ApiClient, sync: DraftSync): MaskSwitch {
  const status = createStore<MaskRead>({ kind: 'idle' });
  let newest = 0;
  let controller: AbortController | undefined;
  let carried = NO_PLACEHOLDERS;
  let before: ReturnType<DraftSync['snapshot']>;
  let reading: { readonly id: string | null; readonly sourceId: string | null } | undefined;
  let committing = false;

  async function readAgain(serial: number, signal: AbortSignal): Promise<void> {
    const held = state.investigation.getState();
    const mask = state.mask.getState();
    const [first] = held.resultKeys;
    if (held.sourceId === null || first === undefined) return;
    const unread = new Set([...carried.nodes.map((node) => elementKey(node.ref)), ...carried.edges.map((edge) => edgeKey(edge.ref))]);
    const entities = held.nodeRefs.filter((ref) => !unread.has(elementKey(ref)));
    const edgeRefs = held.edgeRefs.filter((ref) => !unread.has(edgeKey(ref)));
    const calls = [
      ...chunks(entities).map((list) => ({ entities: list })),
      ...chunks(STORED_EDGES(edgeRefs)).map((list) => ({ edges: list })),
      ...chunks(AGGREGATE_EDGES(edgeRefs)).map((list) => ({ aggregates: list })),
      ...chunks(DERIVED_EDGES(edgeRefs)).map((list) => ({ derived: list })),
    ];
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const missingEntities: ElementRef[] = [];
    const missingEdges: EdgeRef[] = [];
    for (const call of calls) {
      const answer = await client.readRefs({ sourceId: held.sourceId, ...(mask ? { mask: true } : {}), entities: [], edges: [], aggregates: [], derived: [], ...call }, signal);
      if (serial !== newest) return;
      if (!answer.ok) {
        status.setState({ kind: 'failed', failure: answer.failure });
        return;
      }
      nodes.push(...answer.value.nodes);
      edges.push(...answer.value.edges);
      missingEntities.push(...answer.value.missing.entities);
      missingEdges.push(...answer.value.missing.edges);
    }
    const now = state.investigation.getState();
    if (now.id !== held.id || now.sourceId !== held.sourceId || !state.rereading.getState()) return;
    const all = { nodes: [...nodes, ...carried.nodes], edges: [...edges, ...carried.edges] };
    try {
      committing = true;
      state.finishMaskRead({
        key: { ...first, params: `reread:${held.id ?? 'view'}:${serial}`, mask },
        result: { sourceId: held.sourceId, nodes: all.nodes, edges: all.edges },
        nodeRefs: all.nodes.map((node) => node.ref),
        edgeRefs: all.edges.map((edge) => edge.ref),
      });
    } catch (error) {
      committing = false;
      if (!(error instanceof StateError)) throw error;
      if (error.code !== 'MASK_CHANGED') status.setState({ kind: 'failed', failure: { code: 'SCHEMA_MISMATCH' } });
      return;
    }
    committing = false;
    const missing = missingEntities.length + missingEdges.length > 0;
    if (missing && before !== undefined) sync.keepMissing(before, { entities: missingEntities, edges: missingEdges });
    carried = NO_PLACEHOLDERS;
    before = undefined;
    reading = undefined;
    restoreNoticeOf(state).set(missing);
    status.setState({ kind: 'idle' });
  }

  /** Ends what a read in flight would still do: another investigation took the place of the one it reads. */
  function forget(): void {
    newest += 1;
    controller?.abort();
    controller = undefined;
    carried = NO_PLACEHOLDERS;
    before = undefined;
    reading = undefined;
    status.setState({ kind: 'idle' });
  }

  state.investigation.subscribe(() => {
    const now = state.investigation.getState();
    if (reading !== undefined && (now.id !== reading.id || now.sourceId !== reading.sourceId)) forget();
  });

  // a view put in the place of the one being read again, without a change of investigation, ends the read too
  state.rereading.subscribe(() => {
    if (!state.rereading.getState() && !committing && reading !== undefined) forget();
  });

  function begin(): void {
    controller?.abort();
    const mine = ++newest;
    controller = new AbortController();
    if (!state.rereading.getState()) {
      status.setState({ kind: 'idle' });
      return;
    }
    const held = state.investigation.getState();
    reading = { id: held.id, sourceId: held.sourceId };
    status.setState({ kind: 'reading' });
    void readAgain(mine, controller.signal);
  }

  return {
    status: readable(status),
    turn(mask) {
      if (state.mask.getState() === mask) return;
      if (!state.rereading.getState()) {
        const graph = state.loadedGraph();
        carried = { nodes: graph.nodes.filter(isUnmappedNode), edges: graph.edges.filter(isUnmappedEdge) };
        before = sync.snapshot();
      }
      state.setMask(mask);
      begin();
    },
    retry() {
      if (status.getState().kind === 'failed') begin();
    },
  };
}

const switches = new WeakMap<ClientState, MaskSwitch>();

/** The one mask switch of a client state: it lives as long as the state does, so a read that is running survives leaving the panel. */
export function maskSwitchOf(state: ClientState, client: ApiClient): MaskSwitch {
  let found = switches.get(state);
  if (found === undefined) {
    found = createMaskSwitch(state, withoutReadsWhileSourceChanged(client, state), draftSyncOf(state, client));
    switches.set(state, found);
  }
  return found;
}
