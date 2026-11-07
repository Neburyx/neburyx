import type { ElementRef, ExpandRequest, ExpandResponse, GraphEdge } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey, queryKeyText, type QueryKey } from '../state/keys.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import type { ApiClient, ApiFailure } from './client.js';
import { UNEXPECTED } from './use-request.js';

/** What the client knows of the pages of one neighbor type of one node: how many of its relationships are on the canvas, where the next page starts, and whether that cursor can still be used. */
export interface TypeProgress {
  readonly loaded: number;
  readonly hasMore: boolean;
  readonly cursor: string | undefined;
  /** The server refused the cursor (it expired, or the policy changed): the type continues only from its first page. */
  readonly restartNeeded: boolean;
}

export interface NodeExpansion {
  readonly epoch: string;
  readonly status: 'idle' | 'loading' | 'failed';
  readonly failure: ApiFailure | undefined;
  readonly types: ReadonlyMap<string, TypeProgress>;
  /** The page size the server last used for this node. */
  readonly pageSize: number | undefined;
  readonly duplicates: boolean;
  readonly warnings: readonly string[];
  /** What was asked when the last ask failed. */
  readonly failedAction: ExpansionAction | undefined;
}

export type ExpansionAction = { readonly kind: 'first'; readonly types: readonly string[] } | { readonly kind: 'more'; readonly type: string } | { readonly kind: 'restart'; readonly type: string };

export interface ExpandStore {
  readonly view: ReadableStore<ReadonlyMap<string, NodeExpansion>>;
  /** The expansion of a node as it stands for this investigation and mask; idle when nothing was asked, or when what was asked belongs to another investigation or masking. */
  of(ref: ElementRef): NodeExpansion;
  /** What a person is told about an expansion that was not asked for, such as a node that cannot be expanded; cleared when the next expansion is asked. */
  readonly notes: ReadableStore<readonly string[]>;
  report(note: string): void;
  expand(ref: ElementRef, neighborTypes: readonly string[]): Promise<void>;
  loadMore(ref: ElementRef, neighborType: string): Promise<void>;
  startOver(ref: ElementRef, neighborType: string): Promise<void>;
  /** Asks again for what failed last for the node. */
  retry(ref: ElementRef): Promise<void>;
}

const idle = (epoch: string): NodeExpansion => ({ epoch, status: 'idle', failure: undefined, types: new Map(), pageSize: undefined, duplicates: false, warnings: [], failedAction: undefined });

interface Chain {
  /** The relationships of this type that are on the canvas because of this node. */
  all: Set<string>;
  /** The relationships that came from the pages of the chain now running. */
  chain: Set<string>;
}

function neighborTypeOf(edge: GraphEdge, ref: ElementRef): string {
  const anchored = edge.from.entityType === ref.entityType && edge.from.stableId === ref.stableId;
  return (anchored ? edge.to : edge.from).entityType;
}

/**
 * The expansions a person asked for in this session, outside React so that a menu that closes does not stop one. One request is one node's pages for the asked types and either adds all of its answer to the
 * loaded graph or nothing; an answer that arrives after the investigation or the masking changed, or after a newer ask for the same node, is dropped.
 */
export function createExpandStore(client: ApiClient, state: ClientState, person: () => string): ExpandStore {
  const store = createStore<ReadonlyMap<string, NodeExpansion>>(new Map());
  const notes = createStore<readonly string[]>([]);
  const chains = new Map<string, Map<string, Chain>>();
  const newest = new Map<string, number>();
  const last = new Map<string, ExpansionAction>();
  const placed = new Map<string, QueryKey>();
  let counter = 0;

  const epochOf = (): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);
  let idleFor: NodeExpansion | undefined;
  const read = (nodeKey: string): NodeExpansion => {
    const held = store.getState().get(nodeKey);
    const epoch = epochOf();
    if (held !== undefined && held.epoch === epoch) return held;
    // the same idle state while nothing changed, so a component that reads it is not told of a change at each render
    if (idleFor?.epoch !== epoch) idleFor = idle(epoch);
    return idleFor;
  };
  const write = (nodeKey: string, next: NodeExpansion): void => store.setState(new Map(store.getState()).set(nodeKey, next));
  const chainsOf = (nodeKey: string): Map<string, Chain> => {
    const epochKey = `${epochOf()}|${nodeKey}`;
    const held = chains.get(epochKey) ?? new Map<string, Chain>();
    chains.set(epochKey, held);
    return held;
  };

  const patchDuplicates = (flagged: readonly string[]): void => {
    const byResult = new Map<string, { readonly queryKey: QueryKey; readonly edges: Set<string> }>();
    for (const edge of flagged) {
      const queryKey = placed.get(edge);
      if (queryKey === undefined) continue;
      const held = byResult.get(queryKeyText(queryKey)) ?? { queryKey, edges: new Set<string>() };
      held.edges.add(edge);
      byResult.set(queryKeyText(queryKey), held);
    }
    for (const { queryKey, edges } of byResult.values()) {
      const result = state.server.get(queryKey);
      if (result === undefined) continue;
      state.putResult(queryKey, { ...result, edges: result.edges.map((edge) => (edges.has(edgeKey(edge.ref)) && !edge.qualityFlags.includes('conflicting-duplicate') ? { ...edge, qualityFlags: [...edge.qualityFlags, 'conflicting-duplicate'] } : edge)) });
    }
  };

  const merge = (ref: ElementRef, answer: ExpandResponse, action: ExpansionAction, nodeKey: string): { readonly duplicates: readonly string[] } => {
    const current = state.investigation.getState();
    const heldNodes = new Set(current.nodeRefs.map(elementKey));
    const heldEdges = new Set(current.edgeRefs.map(edgeKey));
    const typeChains = chainsOf(nodeKey);
    // a first page or a restart begins a new chain, and only once its answer is here: a failed ask leaves the chain it had
    if (action.kind !== 'more') for (const type of action.kind === 'first' ? action.types : [action.type]) typeChains.set(type, { all: typeChains.get(type)?.all ?? new Set<string>(), chain: new Set<string>() });
    const duplicates: string[] = [];
    const fresh = answer.edges.filter((edge) => !heldEdges.has(edgeKey(edge.ref)));
    const freshNodes = answer.nodes.filter((node) => !heldNodes.has(elementKey(node.ref)));
    for (const edge of answer.edges) {
      const type = neighborTypeOf(edge, ref);
      const chain = typeChains.get(type) ?? { all: new Set<string>(), chain: new Set<string>() };
      typeChains.set(type, chain);
      const key = edgeKey(edge.ref);
      if (action.kind === 'more' && action.type === type && chain.chain.has(key)) duplicates.push(key);
      if (edge.qualityFlags.includes('conflicting-duplicate')) duplicates.push(key);
      chain.all.add(key);
      chain.chain.add(key);
    }
    const queryKey: QueryKey = { sourceId: ref.sourceId, principalId: person(), policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['expanded', current.id, nodeKey, ++counter]), mask: state.mask.getState() };
    if (freshNodes.length > 0 || fresh.length > 0) {
      state.putResult(queryKey, { sourceId: ref.sourceId, nodes: freshNodes, edges: fresh });
      state.setLoaded([...current.resultKeys, queryKey], [...current.nodeRefs, ...freshNodes.map((node) => node.ref)], [...current.edgeRefs, ...fresh.map((edge) => edge.ref)]);
      for (const edge of fresh) placed.set(edgeKey(edge.ref), queryKey);
      state.presentation.select([...freshNodes.map((node) => elementKey(node.ref)), ...fresh.map((edge) => edgeKey(edge.ref))]);
    }
    return { duplicates: [...new Set(duplicates)] };
  };

  async function run(ref: ElementRef, action: ExpansionAction): Promise<void> {
    const nodeKey = elementKey(ref);
    const epoch = epochOf();
    const mine = (newest.get(nodeKey) ?? 0) + 1;
    newest.set(nodeKey, mine);
    last.set(nodeKey, action);
    notes.setState([]);
    const before = read(nodeKey);
    write(nodeKey, { ...before, status: 'loading', failure: undefined, failedAction: undefined });
    const types = action.kind === 'first' ? action.types : [action.type];
    const cursor = action.kind === 'more' ? before.types.get(action.type)?.cursor : undefined;
    const request: ExpandRequest = {
      sourceId: ref.sourceId,
      ref: { entityType: ref.entityType, stableId: ref.stableId },
      neighborTypes: [...types],
      direction: 'both',
      ...(state.mask.getState() ? { mask: true } : {}),
      ...(cursor === undefined || action.kind !== 'more' ? {} : { cursors: { [action.type]: cursor } }),
    };
    let result;
    try {
      result = await client.expandNeighbors(request);
    } catch {
      result = UNEXPECTED;
    }
    if (newest.get(nodeKey) !== mine || epochOf() !== epoch) return;
    if (!result.ok) {
      if (result.failure.code === 'ABORTED') return;
      const restart = action.kind === 'more' && result.failure.code === 'CURSOR_INVALIDATED';
      const progress = new Map(before.types);
      if (restart) progress.set(action.type, { ...(before.types.get(action.type) ?? { loaded: 0, hasMore: true, cursor: undefined }), restartNeeded: true });
      write(nodeKey, { ...before, status: 'failed', failure: result.failure, types: progress, failedAction: action });
      return;
    }
    const { duplicates } = merge(ref, result.value, action, nodeKey);
    if (duplicates.length > 0) patchDuplicates(duplicates);
    const progress = new Map(before.types);
    for (const page of result.value.pages) {
      const chain = chainsOf(nodeKey).get(page.neighborType);
      progress.set(page.neighborType, { loaded: chain?.all.size ?? 0, hasMore: page.hasMore, cursor: page.nextCursor, restartNeeded: false });
    }
    write(nodeKey, { epoch, status: 'idle', failure: undefined, types: progress, pageSize: result.value.pageSize, duplicates: before.duplicates || duplicates.length > 0, warnings: result.value.warnings, failedAction: undefined });
  }

  return {
    view: readable(store),
    of: (ref) => read(elementKey(ref)),
    notes: readable(notes),
    report: (note) => notes.setState([note]),
    expand: (ref, neighborTypes) => run(ref, { kind: 'first', types: neighborTypes }),
    loadMore: (ref, neighborType) => run(ref, { kind: 'more', type: neighborType }),
    startOver: (ref, neighborType) => run(ref, { kind: 'restart', type: neighborType }),
    retry: async (ref) => {
      const action = last.get(elementKey(ref));
      if (action !== undefined) await run(ref, action);
    },
  };
}
