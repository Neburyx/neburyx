import type { ElementRef, ExpandRequest, ExpandResponse, GraphEdge } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey, queryKeyText, type QueryKey } from '../state/keys.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import type { ApiClient, ApiFailure } from './client.js';
import type { FailureReporter } from './failure-reporter.js';
import { UNEXPECTED } from './use-request.js';

/** What the client knows of the pages of one neighbor type of one node: how many of its relationships are on the canvas, where the next page starts, and whether that cursor can still be used. */
export interface TypeProgress {
  readonly loaded: number;
  readonly hasMore: boolean;
  readonly cursor: string | undefined;
  /** The server refused the cursor (it expired, or the policy changed): the type continues only from its first page. */
  readonly restartNeeded: boolean;
}

/** The most a page may hold until a source says otherwise; the server's `max_page` may be lower, and a refusal that names it lowers this for the source. */
export const PAGE_CEILING = 50;
/** What the page size field shows when the node has no answered page size and no preview. */
export const FALLBACK_PAGE_SIZE = 25;

export type PageSizeCheck = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: 'not-whole' | 'below-one' | 'above-ceiling'; readonly ceiling: number };

export interface NodeExpansion {
  readonly epoch: string;
  readonly status: 'idle' | 'loading' | 'failed';
  readonly failure: ApiFailure | undefined;
  readonly types: ReadonlyMap<string, TypeProgress>;
  /** The page size the server last used for this node. */
  readonly pageSize: number | undefined;
  /** The page size the person set for this node, sent as `limit` by every ask for it; none until they set one, and the server's default applies then. */
  readonly chosenPageSize: number | undefined;
  readonly duplicates: boolean;
  readonly warnings: readonly string[];
  /** What was asked when the last ask failed. */
  readonly failedAction: ExpansionAction | undefined;
}

export type ExpansionAction = { readonly kind: 'first'; readonly types: readonly string[]; readonly relTypes?: readonly string[] | undefined } | { readonly kind: 'more'; readonly type: string } | { readonly kind: 'restart'; readonly type: string } | { readonly kind: 'pages'; readonly first: readonly string[]; readonly more: readonly string[]; readonly relTypes: readonly string[] | undefined };

const firstTypesOf = (action: ExpansionAction): readonly string[] => (action.kind === 'first' ? action.types : action.kind === 'restart' ? [action.type] : action.kind === 'pages' ? action.first : []);
const moreTypesOf = (action: ExpansionAction): readonly string[] => (action.kind === 'more' ? [action.type] : action.kind === 'pages' ? action.more : []);
const askedTypesOf = (action: ExpansionAction): readonly string[] => [...firstTypesOf(action), ...moreTypesOf(action)];

/** The last ask failed because a cursor it sent was refused: it can never succeed again, so the type starts over instead of being retried. */
export const cursorWasRefused = (expansion: NodeExpansion): boolean => expansion.failure?.code === 'CURSOR_INVALIDATED' && expansion.failedAction !== undefined && moreTypesOf(expansion.failedAction).length > 0;

export interface ExpandStore {
  readonly view: ReadableStore<ReadonlyMap<string, NodeExpansion>>;
  /** The expansion of a node as it stands for this investigation and mask; idle when nothing was asked, or when what was asked belongs to another investigation or masking. */
  of(ref: ElementRef): NodeExpansion;
  /** The nodes a person opened in the panel or expanded in this investigation under this masking setting, by key; aggregate nodes are drawn for these only. */
  readonly touched: ReadableStore<ReadonlySet<string>>;
  touch(ref: ElementRef): void;
  /** What a person is told about an expansion that was not asked for, such as a node that cannot be expanded; cleared when the next expansion is asked. */
  readonly notes: ReadableStore<readonly string[]>;
  report(note: string): void;
  /** Loads the first page of each neighbor type, over the relationship types given (all sourced types when none), as one request; it begins a new chain for each type. */
  expand(ref: ElementRef, neighborTypes: readonly string[], relTypes?: readonly string[]): Promise<void>;
  /** The page size the person may choose for the source: whole, from 1 to this. */
  ceilingOf(sourceId: string): number;
  /** Checks a page size and, when it is acceptable, keeps it for the node; nothing is kept and the reason is returned otherwise. */
  setPageSize(ref: ElementRef, value: number): PageSizeCheck;
  /** The relationship types the loaded chain of a neighbor type was started with; undefined for all sourced types or when there is no chain. */
  relTypesOf(ref: ElementRef, neighborType: string): readonly string[] | undefined;
  loadMore(ref: ElementRef, neighborType: string): Promise<void>;
  startOver(ref: ElementRef, neighborType: string): Promise<void>;
  /** Asks again for what failed last for the node. */
  retry(ref: ElementRef): Promise<void>;
  /** One request for the panel: the first page of the types in `first` and the next page of those in `more` (each with the cursor it was given), over the relationship types given. */
  load(ref: ElementRef, plan: { readonly first: readonly string[]; readonly more: readonly string[]; readonly relTypes: readonly string[] | undefined }): Promise<void>;
}

const idle = (epoch: string): NodeExpansion => ({ epoch, status: 'idle', failure: undefined, types: new Map(), pageSize: undefined, chosenPageSize: undefined, duplicates: false, warnings: [], failedAction: undefined });

interface Chain {
  /** The relationships of this type that are on the canvas because of this node. */
  all: Set<string>;
  /** The relationships that came from the pages of the chain now running. */
  chain: Set<string>;
  /** The relationship types the chain was started with: the cursor binds them. */
  relTypes: readonly string[] | undefined;
}

function neighborTypeOf(edge: GraphEdge, ref: ElementRef): string {
  const anchored = edge.from.entityType === ref.entityType && edge.from.stableId === ref.stableId;
  return (anchored ? edge.to : edge.from).entityType;
}

/**
 * The expansions a person asked for in this session, outside React so that a menu that closes does not stop one. One request is one node's pages for the asked types and either adds all of its answer to the
 * loaded graph or nothing; an answer that arrives after the investigation or the masking changed, or after a newer ask for the same node, is dropped.
 */
export function createExpandStore(client: ApiClient, state: ClientState, person: () => string, report?: FailureReporter): ExpandStore {
  const store = createStore<ReadonlyMap<string, NodeExpansion>>(new Map());
  const notes = createStore<readonly string[]>([]);
  const chains = new Map<string, Map<string, Chain>>();
  const newest = new Map<string, number>();
  const last = new Map<string, ExpansionAction>();
  const placed = new Map<string, QueryKey>();
  const ceilings = new Map<string, number>();
  const touchedHeld = createStore<{ readonly epoch: string; readonly keys: ReadonlySet<string> }>({ epoch: '', keys: new Set() });
  const NONE: ReadonlySet<string> = new Set();
  const touchedView: ReadableStore<ReadonlySet<string>> = { getState: () => (touchedHeld.getState().epoch === epochOf() ? touchedHeld.getState().keys : NONE), subscribe: touchedHeld.subscribe };
  const touch = (ref: ElementRef): void => {
    const held = touchedHeld.getState();
    const key = elementKey(ref);
    const epoch = epochOf();
    if (held.epoch === epoch && held.keys.has(key)) return;
    touchedHeld.setState({ epoch, keys: new Set([...(held.epoch === epoch ? held.keys : []), key]) });
  };
  let counter = 0;
  const ceilingOf = (sourceId: string): number => ceilings.get(sourceId) ?? PAGE_CEILING;

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
    for (const type of firstTypesOf(action)) typeChains.set(type, { all: typeChains.get(type)?.all ?? new Set<string>(), chain: new Set<string>(), relTypes: action.kind === 'first' || action.kind === 'pages' ? action.relTypes : typeChains.get(type)?.relTypes });
    const duplicates: string[] = [];
    const fresh = answer.edges.filter((edge) => !heldEdges.has(edgeKey(edge.ref)));
    const freshNodes = answer.nodes.filter((node) => !heldNodes.has(elementKey(node.ref)));
    for (const edge of answer.edges) {
      const type = neighborTypeOf(edge, ref);
      const chain = typeChains.get(type) ?? { all: new Set<string>(), chain: new Set<string>(), relTypes: undefined };
      typeChains.set(type, chain);
      const key = edgeKey(edge.ref);
      if (moreTypesOf(action).includes(type) && chain.chain.has(key)) duplicates.push(key);
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
    touch(ref);
    const mine = (newest.get(nodeKey) ?? 0) + 1;
    newest.set(nodeKey, mine);
    last.set(nodeKey, action);
    notes.setState([]);
    const before = read(nodeKey);
    write(nodeKey, { ...before, status: 'loading', failure: undefined, failedAction: undefined });
    const types = askedTypesOf(action);
    const cursors = Object.fromEntries(moreTypesOf(action).flatMap((type) => {
      const cursor = before.types.get(type)?.cursor;
      return cursor === undefined ? [] : [[type, cursor] as const];
    }));
    // the cursor binds the relationship types, so a continuation asks for the ones its chain began with
    const relTypes = action.kind === 'first' || action.kind === 'pages' ? action.relTypes : chainsOf(nodeKey).get(action.type)?.relTypes;
    const request: ExpandRequest = {
      sourceId: ref.sourceId,
      ref: { entityType: ref.entityType, stableId: ref.stableId },
      neighborTypes: [...types],
      direction: 'both',
      ...(relTypes === undefined || relTypes.length === 0 ? {} : { relTypes: [...relTypes], sort: 'observed' as const }),
      ...(before.chosenPageSize === undefined ? {} : { limit: before.chosenPageSize }),
      ...(state.mask.getState() ? { mask: true } : {}),
      ...(Object.keys(cursors).length === 0 ? {} : { cursors }),
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
      const maxPage = result.failure.code === 'QUERY_BUDGET_EXCEEDED' && 'details' in result.failure ? result.failure.details?.maxPage : undefined;
      if (maxPage !== undefined) ceilings.set(ref.sourceId, maxPage);
      const lowered = maxPage !== undefined && before.chosenPageSize !== undefined && before.chosenPageSize > maxPage ? maxPage : before.chosenPageSize;
      // shown elsewhere (the banner): the node goes back to what it was, and the banner's Retry asks the same again
      if (report?.(result.failure, ref.sourceId, () => void run(ref, action)) === true) {
        write(nodeKey, { ...before, chosenPageSize: lowered, status: 'idle', failure: undefined, failedAction: undefined });
        return;
      }
      const restart = moreTypesOf(action).length > 0 && result.failure.code === 'CURSOR_INVALIDATED';
      const progress = new Map(before.types);
      if (restart) for (const type of moreTypesOf(action)) progress.set(type, { ...(before.types.get(type) ?? { loaded: 0, hasMore: true, cursor: undefined }), restartNeeded: true });
      write(nodeKey, { ...before, chosenPageSize: lowered, status: 'failed', failure: result.failure, types: progress, failedAction: action });
      return;
    }
    const { duplicates } = merge(ref, result.value, action, nodeKey);
    if (duplicates.length > 0) patchDuplicates(duplicates);
    const progress = new Map(before.types);
    for (const page of result.value.pages) {
      const chain = chainsOf(nodeKey).get(page.neighborType);
      progress.set(page.neighborType, { loaded: chain?.all.size ?? 0, hasMore: page.hasMore, cursor: page.nextCursor, restartNeeded: false });
    }
    write(nodeKey, { epoch, status: 'idle', failure: undefined, types: progress, pageSize: result.value.pageSize, chosenPageSize: before.chosenPageSize, duplicates: before.duplicates || duplicates.length > 0, warnings: result.value.warnings, failedAction: undefined });
  }

  return {
    view: readable(store),
    of: (ref) => read(elementKey(ref)),
    notes: readable(notes),
    touched: touchedView,
    touch,
    report: (note) => notes.setState([note]),
    expand: (ref, neighborTypes, relTypes) => run(ref, { kind: 'first', types: neighborTypes, relTypes }),
    load: (ref, plan) => run(ref, { kind: 'pages', first: plan.first, more: plan.more, relTypes: plan.relTypes }),
    ceilingOf,
    setPageSize(ref, value) {
      const ceiling = ceilingOf(ref.sourceId);
      if (!Number.isInteger(value)) return { ok: false, reason: 'not-whole', ceiling };
      if (value < 1) return { ok: false, reason: 'below-one', ceiling };
      if (value > ceiling) return { ok: false, reason: 'above-ceiling', ceiling };
      const nodeKey = elementKey(ref);
      write(nodeKey, { ...read(nodeKey), chosenPageSize: value });
      return { ok: true, value };
    },
    relTypesOf: (ref, neighborType) => chains.get(`${epochOf()}|${elementKey(ref)}`)?.get(neighborType)?.relTypes,
    loadMore: (ref, neighborType) => run(ref, { kind: 'more', type: neighborType }),
    startOver: (ref, neighborType) => run(ref, { kind: 'restart', type: neighborType }),
    retry: async (ref) => {
      const action = last.get(elementKey(ref));
      if (action !== undefined) await run(ref, action);
    },
  };
}
