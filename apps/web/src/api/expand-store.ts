import type { Count, ElementRef, ExpandFilter, ExpandRank, ExpandRequest, ExpandResponse, GraphEdge } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey, queryKeyText, type QueryKey } from '../state/keys.js';
import { outsideFocusNote } from '../canvas/focus-note.js';
import { drawnKeys, outsideFocusKeys } from '../state/loaded-graph.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import type { ApiClient, ApiFailure } from './client.js';
import type { RequestTracker } from '../banner/request-tracker.js';
import type { RequestKind } from '../banner/copy.js';
import type { FailureReporter } from './failure-reporter.js';
import { UNEXPECTED } from './use-request.js';
import { BOUNDED_LIMIT } from './heavy-estimate.js';
import type { HeavyGuard } from './heavy-guard.js';

/** What narrows and orders an expansion beyond its types: the conditions on the neighbors and the relationships, and the property the pages are ranked by instead of the observed time. */
export interface Refinement {
  readonly filters: readonly ExpandFilter[];
  readonly rank: ExpandRank | undefined;
}

/** The refinement as text, so that two refinements are the same ask exactly when their texts are equal. */
export const refinementKey = (refinement: Refinement | undefined): string => JSON.stringify([[...(refinement?.filters ?? [])].map((filter) => JSON.stringify(filter)).sort(), refinement?.rank ?? null]);

/** What the client knows of the pages of one neighbor type of one node: how many of its relationships are on the canvas, where the next page starts, and whether that cursor can still be used. */
export interface TypeProgress {
  readonly loaded: number;
  readonly hasMore: boolean;
  readonly cursor: string | undefined;
  /** The server refused the cursor (it expired, or the policy changed): the type continues only from its first page. */
  readonly restartNeeded: boolean;
  /** How many relationships match the filters of the chain, as the first page of the chain counted them; none when the chain has no filter. It is kept for the later pages, which do not count again. */
  readonly matching?: Count | undefined;
  /** How many relationships the pages of the chain now running brought, whether or not they were already on the canvas. */
  readonly inChain?: number | undefined;
}

const notAskedAfterFailure = (count: number): string => `${count} selected ${count === 1 ? 'node was' : 'nodes were'} not asked after the failure.`;
export const NOTHING_NEW = 'Nothing new: everything on this page is already loaded';
const notAskedAfterMasking = (count: number): string => `${count} selected ${count === 1 ? 'node was' : 'nodes were'} not asked because the masking changed.`;

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

/** What a request did: `sent` a request left and was answered, `failed` it left and failed, `held` the heavy-operation warning stopped it and waits for the person, `stale` a newer ask or a change of investigation or masking made it moot. */
export type ExpandOutcome = 'sent' | 'held' | 'stale' | 'failed';

/** A selection that is expanded node after node: how many of its nodes are still to be asked, the held one included, and the rest of the run, which goes on once the held node has been let through. */
export interface ExpandBatch {
  readonly waiting: number;
  /** How many nodes the batch asks; absent for a batch of one. */
  readonly size?: number;
  /** The person let the held node through: a heavy node of the rest goes ahead at its own bounded limit and is not held again. */
  readonly bounded?: boolean;
  readonly after: () => Promise<unknown>;
}

/** `checked` marks an ask that has passed the heavy-operation check, so a retry of it is not checked again; `limit` is the bounded page *Continue* chose, kept by that retry. */
interface Passed {
  readonly checked?: true;
  readonly limit?: number | undefined;
}

export type ExpansionAction =
  | ({ readonly kind: 'first'; readonly types: readonly string[]; readonly relTypes?: readonly string[] | undefined; readonly refinement?: Refinement | undefined; readonly batch?: ExpandBatch | undefined } & Passed)
  | { readonly kind: 'more'; readonly type: string }
  | { readonly kind: 'restart'; readonly type: string }
  | ({ readonly kind: 'pages'; readonly first: readonly string[]; readonly more: readonly string[]; readonly relTypes: readonly string[] | undefined; readonly refinement?: Refinement | undefined } & Passed);

const requestKindOf = (action: ExpansionAction): RequestKind => (action.kind === 'more' || (action.kind === 'pages' && action.first.length === 0) ? 'more' : action.kind === 'restart' ? 'start-over' : 'expand');

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
  expand(ref: ElementRef, neighborTypes: readonly string[], relTypes?: readonly string[], batch?: ExpandBatch): Promise<ExpandOutcome>;
  /** The page size the person may choose for the source: whole, from 1 to this. */
  ceilingOf(sourceId: string): number;
  /** Checks a page size and, when it is acceptable, keeps it for the node; nothing is kept and the reason is returned otherwise. */
  setPageSize(ref: ElementRef, value: number): PageSizeCheck;
  /** The relationship types the loaded chain of a neighbor type was started with; undefined for all sourced types or when there is no chain. */
  relTypesOf(ref: ElementRef, neighborType: string): readonly string[] | undefined;
  /** The filters and the rank the loaded chain of a neighbor type was started with; undefined when it has none or there is no chain. */
  refinementOf(ref: ElementRef, neighborType: string): Refinement | undefined;
  loadMore(ref: ElementRef, neighborType: string): Promise<ExpandOutcome>;
  startOver(ref: ElementRef, neighborType: string): Promise<ExpandOutcome>;
  /** Asks again for what failed last for the node. */
  retry(ref: ElementRef): Promise<ExpandOutcome>;
  /** Whether the node's expansion can be taken back now: `yes`, `loading` while an ask for it is running, `nothing` when no element is held because of it (never expanded, collapsed, or the investigation or masking changed). */
  collapsibility(ref: ElementRef): Collapsibility;
  /** Takes back the node's expansion: removes the elements only it brought to the canvas and nothing else keeps, clears what the store holds of its paging, and sends no request. */
  collapse(ref: ElementRef): Collapsibility | 'collapsed';
  /** Tells the store that the person asked for an entity by a route other than an expansion, so no collapse removes it. */
  keep(ref: ElementRef): void;
  /** Changes when the keeper record changes, for components that show whether a node can be collapsed. */
  readonly records: ReadableStore<number>;
  /** One request for the panel: the first page of the types in `first` and the next page of those in `more` (each with the cursor it was given), over the relationship types given. */
  load(ref: ElementRef, plan: { readonly first: readonly string[]; readonly more: readonly string[]; readonly relTypes: readonly string[] | undefined; readonly refinement?: Refinement | undefined }): Promise<ExpandOutcome>;
}

export type Collapsibility = 'yes' | 'loading' | 'nothing';

/** What is on the canvas because of expansions, in one epoch: for each element the nodes whose uncollapsed expansions returned it, and the elements nothing may remove. */
interface Keepers {
  readonly epoch: string;
  readonly nodes: Map<string, Set<string>>;
  readonly edges: Map<string, Set<string>>;
  readonly edgeEnds: Map<string, readonly [string, string]>;
  /** By expanding node: the elements it is a keeper of. */
  readonly of: Map<string, { readonly nodes: Set<string>; readonly edges: Set<string> }>;
  readonly keptNodes: Set<string>;
  readonly keptEdges: Set<string>;
}

const idle = (epoch: string): NodeExpansion => ({ epoch, status: 'idle', failure: undefined, types: new Map(), pageSize: undefined, chosenPageSize: undefined, duplicates: false, warnings: [], failedAction: undefined });

interface Chain {
  /** The relationships of this type that are on the canvas because of this node. */
  all: Set<string>;
  /** The relationships that came from the pages of the chain now running. */
  chain: Set<string>;
  /** The relationship types the chain was started with: the cursor binds them. */
  relTypes: readonly string[] | undefined;
  /** The filters and the rank the chain was started with: the cursor binds them too. */
  refinement: Refinement | undefined;
}

function neighborTypeOf(edge: GraphEdge, ref: ElementRef): string {
  const anchored = edge.from.entityType === ref.entityType && edge.from.stableId === ref.stableId;
  return (anchored ? edge.to : edge.from).entityType;
}

/**
 * The expansions a person asked for in this session, outside React so that a menu that closes does not stop one. One request is one node's pages for the asked types and either adds all of its answer to the
 * loaded graph or nothing; an answer that arrives after the investigation or the masking changed, or after a newer ask for the same node, is dropped.
 */
export function createExpandStore(client: ApiClient, state: ClientState, person: () => string, report?: FailureReporter, heavy?: HeavyGuard, tracker?: RequestTracker): ExpandStore {
  const store = createStore<ReadonlyMap<string, NodeExpansion>>(new Map());
  const notes = createStore<readonly string[]>([]);
  const chains = new Map<string, Map<string, Chain>>();
  const newest = new Map<string, number>();
  const collapses = new Map<string, number>();
  const controllers = new Map<string, AbortController>();
  const last = new Map<string, ExpansionAction>();
  const placed = new Map<string, QueryKey>();
  const ceilings = new Map<string, number>();
  let keepers: Keepers | undefined;
  const records = createStore<number>(0);
  const recordsChanged = (): void => records.setState(records.getState() + 1);
  /** The record of this epoch; cleared, never brought back, when the epoch changes. */
  const recordOf = (): Keepers => {
    const epoch = epochOf();
    if (keepers?.epoch !== epoch) keepers = { epoch, nodes: new Map(), edges: new Map(), edgeEnds: new Map(), of: new Map(), keptNodes: new Set(), keptEdges: new Set() };
    return keepers;
  };
  // the record is cleared the moment the epoch changes, so it is not there when the epoch comes back
  state.mask.subscribe(() => recordOf());
  state.investigation.subscribe(() => recordOf());
  const holds = (record: Keepers, nodeKey: string): boolean => {
    const own = record.of.get(nodeKey);
    return own !== undefined && own.nodes.size + own.edges.size > 0;
  };
  const addKeeper = (record: Keepers, table: Map<string, Set<string>>, side: 'nodes' | 'edges', key: string, holder: string): void => {
    table.set(key, (table.get(key) ?? new Set()).add(holder));
    const own = record.of.get(holder) ?? { nodes: new Set<string>(), edges: new Set<string>() };
    own[side].add(key);
    record.of.set(holder, own);
  };
  const keepNode = (record: Keepers, key: string): void => {
    record.keptNodes.add(key);
    for (const holder of record.nodes.get(key) ?? []) record.of.get(holder)?.nodes.delete(key);
    record.nodes.delete(key);
  };
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

  const merge = (ref: ElementRef, answer: ExpandResponse, action: ExpansionAction, nodeKey: string): { readonly duplicates: readonly string[]; readonly nothingNew: boolean } => {
    const current = state.investigation.getState();
    const heldNodes = new Set(current.nodeRefs.map(elementKey));
    const heldEdges = new Set(current.edgeRefs.map(edgeKey));
    const typeChains = chainsOf(nodeKey);
    // a first page or a restart begins a new chain, and only once its answer is here: a failed ask leaves the chain it had
    for (const type of firstTypesOf(action)) typeChains.set(type, { all: typeChains.get(type)?.all ?? new Set<string>(), chain: new Set<string>(), relTypes: action.kind === 'first' || action.kind === 'pages' ? action.relTypes : typeChains.get(type)?.relTypes, refinement: action.kind === 'first' || action.kind === 'pages' ? action.refinement : typeChains.get(type)?.refinement });
    const duplicates: string[] = [];
    const fresh = answer.edges.filter((edge) => !heldEdges.has(edgeKey(edge.ref)));
    const freshNodes = answer.nodes.filter((node) => !heldNodes.has(elementKey(node.ref)));
    for (const edge of answer.edges) {
      const type = neighborTypeOf(edge, ref);
      const chain = typeChains.get(type) ?? { all: new Set<string>(), chain: new Set<string>(), relTypes: undefined, refinement: undefined };
      typeChains.set(type, chain);
      const key = edgeKey(edge.ref);
      if (moreTypesOf(action).includes(type) && chain.chain.has(key)) duplicates.push(key);
      if (edge.qualityFlags.includes('conflicting-duplicate')) duplicates.push(key);
      chain.all.add(key);
      chain.chain.add(key);
    }
    const record = recordOf();
    for (const node of answer.nodes) {
      const key = elementKey(node.ref);
      if (key === nodeKey || record.keptNodes.has(key)) continue;
      if (heldNodes.has(key) && !record.nodes.has(key)) record.keptNodes.add(key);
      else addKeeper(record, record.nodes, 'nodes', key, nodeKey);
    }
    for (const edge of answer.edges) {
      const key = edgeKey(edge.ref);
      if (record.keptEdges.has(key)) continue;
      if (heldEdges.has(key) && !record.edges.has(key)) record.keptEdges.add(key);
      else {
        addKeeper(record, record.edges, 'edges', key, nodeKey);
        record.edgeEnds.set(key, [elementKey(edge.from), elementKey(edge.to)]);
      }
    }
    recordsChanged();
    const queryKey: QueryKey = { sourceId: ref.sourceId, principalId: person(), policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['expanded', current.id, nodeKey, ++counter]), mask: state.mask.getState() };
    if (freshNodes.length > 0 || fresh.length > 0) {
      state.putResult(queryKey, { sourceId: ref.sourceId, nodes: freshNodes, edges: fresh });
      state.setLoaded([...current.resultKeys, queryKey], [...current.nodeRefs, ...freshNodes.map((node) => node.ref)], [...current.edgeRefs, ...fresh.map((edge) => edge.ref)]);
      for (const edge of fresh) placed.set(edgeKey(edge.ref), queryKey);
      const drawn = drawnKeys(state.visibleGraph());
      state.presentation.select([...freshNodes.map((node) => elementKey(node.ref)), ...fresh.map((edge) => edgeKey(edge.ref))].filter((key) => drawn.has(key)));
      const { neighborhoodFocus, hidden } = state.presentation.view.getState();
      if (neighborhoodFocus !== undefined) {
        const outside = outsideFocusKeys(state.loadedGraph(), neighborhoodFocus, hidden);
        const note = outsideFocusNote(freshNodes.filter((node) => outside.has(elementKey(node.ref))).length, freshNodes.length);
        if (note !== undefined) state.presentation.announceMove(note);
      }
    }
    return { duplicates: [...new Set(duplicates)], nothingNew: freshNodes.length === 0 && fresh.length === 0 && answer.edges.length > 0 };
  };

  async function run(ref: ElementRef, action: ExpansionAction): Promise<ExpandOutcome> {
    const nodeKey = elementKey(ref);
    const epoch = epochOf();
    touch(ref);
    heavy?.release(ref);
    const mine = (newest.get(nodeKey) ?? 0) + 1;
    newest.set(nodeKey, mine);
    last.set(nodeKey, action);
    notes.setState([]);
    const before = read(nodeKey);
    write(nodeKey, { ...before, status: 'loading', failure: undefined, failedAction: undefined });
    if (heavy !== undefined && (action.kind === 'first' || action.kind === 'pages') && action.checked !== true) {
      const asked = firstTypesOf(action);
      if (asked.length > 0) {
        const mask = state.mask.getState();
        const decision = await heavy.decide({ ref, neighborTypes: asked, relTypes: action.relTypes }, mask);
        if (newest.get(nodeKey) !== mine || epochOf() !== epoch) return 'stale';
        const limit = decision.kind === 'heavy' ? Math.min(BOUNDED_LIMIT, before.chosenPageSize ?? before.pageSize ?? decision.pageSize, ceilingOf(ref.sourceId)) : undefined;
        if (decision.kind === 'heavy' && limit !== undefined && action.kind === 'first' && action.batch?.bounded === true) {
          // the person let a held node through: the rest of the selection goes ahead, each heavy node at its own bounded page
          action = { ...action, checked: true, limit };
          last.set(nodeKey, action);
        } else if (decision.kind === 'heavy' && limit !== undefined) {
          write(nodeKey, { ...read(nodeKey), status: 'idle', failure: undefined, failedAction: undefined });
          let used = false;
          const maskAtHold = mask;
          const heldAction = action;
          heavy.hold({
            ref,
            decision,
            limit,
            types: askedTypesOf(heldAction).length,
            waiting: heldAction.kind === 'first' ? (heldAction.batch?.waiting ?? 1) : 1,
            proceed() {
              if (used) return;
              const batch = heldAction.kind === 'first' ? heldAction.batch : undefined;
              if (epochOf() !== epoch || newest.get(nodeKey) !== mine) {
                if (batch !== undefined && state.mask.getState() !== maskAtHold) notes.setState([notAskedAfterMasking(batch.waiting)]);
                return;
              }
              used = true;
              void run(ref, { ...heldAction, checked: true, limit, ...(heldAction.kind === 'first' && batch !== undefined ? { batch: { ...batch, bounded: true } } : {}) }).then(async (outcome) => {
                const rest = (batch?.waiting ?? 1) - 1;
                if (batch === undefined || rest < 1) return;
                if (outcome === 'failed') {
                  notes.setState([notAskedAfterFailure(rest)]);
                  return;
                }
                if (epochOf() !== epoch) {
                  if (state.mask.getState() !== maskAtHold) notes.setState([notAskedAfterMasking(rest)]);
                  return;
                }
                await batch.after();
              });
            },
          });
          return 'held';
        }
        if (action.checked !== true) {
          // an ask that passed is not checked again when the banner's Retry or a retry sends it once more
          action = { ...action, checked: true };
          last.set(nodeKey, action);
        }
      }
    }
    const types = askedTypesOf(action);
    const cursors = Object.fromEntries(moreTypesOf(action).flatMap((type) => {
      const cursor = before.types.get(type)?.cursor;
      return cursor === undefined ? [] : [[type, cursor] as const];
    }));
    // the cursor binds the relationship types, so a continuation asks for the ones its chain began with
    const relTypes = action.kind === 'first' || action.kind === 'pages' ? action.relTypes : chainsOf(nodeKey).get(action.type)?.relTypes;
    // the filters and the rank are bound by the cursor too: a continuation asks with the ones its chain began with
    const refinement = action.kind === 'first' || action.kind === 'pages' ? action.refinement : chainsOf(nodeKey).get(action.type)?.refinement;
    const boundedLimit = action.kind === 'first' || action.kind === 'pages' ? action.limit : undefined;
    const request: ExpandRequest = {
      sourceId: ref.sourceId,
      ref: { entityType: ref.entityType, stableId: ref.stableId },
      neighborTypes: [...types],
      direction: 'both',
      ...(relTypes === undefined || relTypes.length === 0 ? {} : { relTypes: [...relTypes], sort: 'observed' as const }),
      ...(boundedLimit === undefined && before.chosenPageSize === undefined ? {} : { limit: boundedLimit ?? before.chosenPageSize }),
      ...(state.mask.getState() ? { mask: true } : {}),
      ...(Object.keys(cursors).length === 0 ? {} : { cursors }),
      ...(refinement === undefined || refinement.filters.length === 0 ? {} : { filters: [...refinement.filters] }),
      ...(refinement?.rank === undefined ? {} : { rank: refinement.rank }),
    };
    // a newer ask for the node stops the older one's fetch, and the person's Cancel stops this one; either way nothing of the answer is merged
    controllers.get(nodeKey)?.abort();
    const controller = new AbortController();
    controllers.set(nodeKey, controller);
    // a banner's Retry made before a collapse of the node does not outlive it
    const collapsedAt = collapses.get(nodeKey) ?? 0;
    const stillMine = (): boolean => (collapses.get(nodeKey) ?? 0) === collapsedAt;
    const tracked = tracker?.begin({ kind: requestKindOf(action), ref, cancel: () => controller.abort(), again: () => (stillMine() ? void run(ref, action) : undefined) });
    let result;
    try {
      result = await client.expandNeighbors(request, controller.signal);
    } catch {
      result = UNEXPECTED;
    } finally {
      tracked?.finish();
      if (controllers.get(nodeKey) === controller) controllers.delete(nodeKey);
    }
    if (newest.get(nodeKey) !== mine || epochOf() !== epoch) return 'stale';
    if (tracked?.cancelled === true || (!result.ok && result.failure.code === 'ABORTED')) {
      // the node goes back to what it was, with the cursors it had, and an answer that came after the cancel is dropped
      write(nodeKey, { ...before, status: 'idle', failure: undefined, failedAction: undefined });
      return 'sent';
    }
    if (!result.ok) {
      const maxPage = result.failure.code === 'QUERY_BUDGET_EXCEEDED' && 'details' in result.failure ? result.failure.details?.maxPage : undefined;
      if (maxPage !== undefined) ceilings.set(ref.sourceId, maxPage);
      const lowered = maxPage !== undefined && before.chosenPageSize !== undefined && before.chosenPageSize > maxPage ? maxPage : before.chosenPageSize;
      // shown elsewhere (the banner): the node goes back to what it was, and the banner's Retry asks the same again
      if (report?.(result.failure, ref.sourceId, () => (stillMine() ? void run(ref, action) : undefined)) === true) {
        write(nodeKey, { ...before, chosenPageSize: lowered, status: 'idle', failure: undefined, failedAction: undefined });
        return 'failed';
      }
      const restart = moreTypesOf(action).length > 0 && result.failure.code === 'CURSOR_INVALIDATED';
      const progress = new Map(before.types);
      if (restart) for (const type of moreTypesOf(action)) progress.set(type, { ...(before.types.get(type) ?? { loaded: 0, hasMore: true, cursor: undefined }), restartNeeded: true });
      write(nodeKey, { ...before, chosenPageSize: lowered, status: 'failed', failure: result.failure, types: progress, failedAction: action });
      return 'failed';
    }
    const { duplicates, nothingNew } = merge(ref, result.value, action, nodeKey);
    // one note for one node: in a batch of several the nodes run one after another and each run clears the notes, so the last node's page would speak for them all
    const ofSeveral = action.kind === 'first' && (action.batch?.size ?? 1) > 1;
    if (nothingNew && !ofSeveral && !notes.getState().includes(NOTHING_NEW)) notes.setState([...notes.getState(), NOTHING_NEW]);
    if (duplicates.length > 0) patchDuplicates(duplicates);
    const progress = new Map(before.types);
    for (const page of result.value.pages) {
      const chain = chainsOf(nodeKey).get(page.neighborType);
      // the first page of a chain with filters counts what they match; the pages after it do not, and keep that number
      const counted = (refinement?.filters.length ?? 0) > 0 ? (firstTypesOf(action).includes(page.neighborType) ? page.matchingTotal : before.types.get(page.neighborType)?.matching) : undefined;
      progress.set(page.neighborType, { loaded: chain?.all.size ?? 0, hasMore: page.hasMore, cursor: page.nextCursor, restartNeeded: false, matching: counted, inChain: chain?.chain.size ?? 0 });
    }
    write(nodeKey, { epoch, status: 'idle', failure: undefined, types: progress, pageSize: result.value.pageSize, chosenPageSize: before.chosenPageSize, duplicates: before.duplicates || duplicates.length > 0, warnings: result.value.warnings, failedAction: undefined });
    return 'sent';
  }

  const collapsibility = (ref: ElementRef): Collapsibility => {
    const nodeKey = elementKey(ref);
    if (read(nodeKey).status === 'loading') return 'loading';
    return holds(recordOf(), nodeKey) ? 'yes' : 'nothing';
  };

  function collapse(ref: ElementRef): Collapsibility | 'collapsed' {
    const nodeKey = elementKey(ref);
    const verdict = collapsibility(ref);
    if (verdict !== 'yes') return verdict;
    const record = recordOf();
    const own = record.of.get(nodeKey);
    record.of.delete(nodeKey);
    const pins = state.presentation.view.getState().pins;
    const leaving = new Set<string>();
    const leavingEdges = new Set<string>();
    for (const key of own?.nodes ?? []) {
      const rest = record.nodes.get(key);
      rest?.delete(nodeKey);
      if (rest !== undefined && rest.size > 0) continue;
      record.nodes.delete(key);
      if (pins.has(key) || holds(record, key)) record.keptNodes.add(key);
      else leaving.add(key);
    }
    for (const key of own?.edges ?? []) {
      const rest = record.edges.get(key);
      rest?.delete(nodeKey);
      if (rest !== undefined && rest.size > 0) continue;
      record.edges.delete(key);
      leavingEdges.add(key);
    }
    for (const [key, ends] of record.edgeEnds) if (!leavingEdges.has(key) && ends.some((end) => leaving.has(end))) leavingEdges.add(key);
    for (const key of leavingEdges) {
      for (const holder of record.edges.get(key) ?? []) record.of.get(holder)?.edges.delete(key);
      record.edges.delete(key);
      record.edgeEnds.delete(key);
      placed.delete(key);
    }
    const current = state.investigation.getState();
    state.setLoaded(
      current.resultKeys,
      current.nodeRefs.filter((held) => !leaving.has(elementKey(held))),
      current.edgeRefs.filter((held) => !leavingEdges.has(edgeKey(held))),
    );
    // what the node's chains, retry and failure held is gone; the page size the person chose and the aggregates (touched) stay
    chains.delete(`${epochOf()}|${nodeKey}`);
    last.delete(nodeKey);
    newest.set(nodeKey, (newest.get(nodeKey) ?? 0) + 1);
    collapses.set(nodeKey, (collapses.get(nodeKey) ?? 0) + 1);
    heavy?.release(ref);
    write(nodeKey, { ...idle(epochOf()), chosenPageSize: read(nodeKey).chosenPageSize });
    recordsChanged();
    return 'collapsed';
  }

  return {
    view: readable(store),
    of: (ref) => read(elementKey(ref)),
    collapsibility,
    collapse,
    records: readable(records),
    keep(ref) {
      const record = recordOf();
      const key = elementKey(ref);
      if (!record.nodes.has(key)) return;
      keepNode(record, key);
      recordsChanged();
    },
    notes: readable(notes),
    touched: touchedView,
    touch,
    report: (note) => notes.setState([note]),
    expand: (ref, neighborTypes, relTypes, batch) => run(ref, { kind: 'first', types: neighborTypes, relTypes, batch }),
    load: (ref, plan) => run(ref, { kind: 'pages', first: plan.first, more: plan.more, relTypes: plan.relTypes, refinement: plan.refinement }),
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
    refinementOf: (ref, neighborType) => chains.get(`${epochOf()}|${elementKey(ref)}`)?.get(neighborType)?.refinement,
    loadMore: (ref, neighborType) => run(ref, { kind: 'more', type: neighborType }),
    startOver: (ref, neighborType) => run(ref, { kind: 'restart', type: neighborType }),
    retry: async (ref) => {
      const action = last.get(elementKey(ref));
      return action === undefined ? 'stale' : run(ref, action);
    },
  };
}
