import { rmSync } from 'node:fs';
import type { ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import { createApiClient, type ApiClient } from '../../../apps/web/src/api/client.js';
import { createExpandStore, type ExpandStore } from '../../../apps/web/src/api/expand-store.js';
import { createDerivedStore, type DerivedStore } from '../../../apps/web/src/api/derived-store.js';
import { createPreviewStore, type PreviewStore } from '../../../apps/web/src/api/preview-store.js';
import { bannerReporter } from '../../../apps/web/src/banner/banner-reporter.js';
import { bindBannerToInvestigation } from '../../../apps/web/src/banner/bind-investigation.js';
import { createBuiltInBannerController } from '../../../apps/web/src/banner/built-in-causes.js';
import { createRequestTracker } from '../../../apps/web/src/banner/request-tracker.js';
import { createClientState, type ClientState } from '../../../apps/web/src/state/client-state.js';
import { elementKey } from '../../../apps/web/src/state/keys.js';
import { key, node, ref, edge } from '../../../apps/web/src/state/test-data.js';
import { buildApp } from '../../../services/api/src/app.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../../../services/api/src/gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { createUsabilityRecord } from '../../../services/api/src/source-test/usability.js';
import { openEntity } from '../../../apps/web/src/investigations/open-flow.js';
import { createReadSlots } from '../../../services/api/src/seams/read-slots.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import type { AuditEvent } from '../../../services/api/src/seams/seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import { portOf } from '../../../services/api/src/testing/raw-request.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../../../services/api/src/testing/search-fixtures.js';
import { assembleGate } from '../../../services/api/src/gate/assemble.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

export const SOURCE = 'demo';
/** The rule of the mapping that starts from the hub. */
export const RULE = 'shared-leaf';
export const HUB: ElementRef = ref(SOURCE, 'hub', 'H-1');
/** A second node to expand, so that two requests are not one node's newer ask replacing its older. */
export const HUB_TWO: ElementRef = ref(SOURCE, 'hub', 'H-2');
export const HUB_THREE: ElementRef = ref(SOURCE, 'hub', 'H-3');

const mappingWith = (budgets: Record<string, number> | undefined) => parseMapping(
  fileOf(
    baseSource({
      ...(budgets === undefined ? {} : { budgets }),
      id: SOURCE,
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        { type: 'part', label: 'Part', stable_id: 'partId' },
        { type: 'item', label: 'Item', stable_id: 'itemId' },
      ],
      relationships: [
        { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' },
        { type: 'HAS', from: 'hub', to: 'part', stable_id: 'relId' },
        { type: 'HOLDS', from: 'hub', to: 'item', stable_id: 'relId' },
      ],
      derived: [{ id: RULE, from: 'hub', to: 'hub', via: ['LINKED', 'leaf', 'LINKED'], rule_version: 1 }],
    }),
  ),
  'neburyx.yaml',
);

const hubNode = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
/** The columns of the answer to a degree read of the hub: one for each mapped pair of its entity type. */
const DEGREE_COLUMNS = 3;
export const NEIGHBOR_TYPES = ['leaf', 'part', 'item'] as const;
const KINDS: Readonly<Record<string, { label: string; idKey: string; rel: string }>> = {
  leaf: { label: 'Leaf', idKey: 'leafId', rel: 'LINKED' },
  part: { label: 'Part', idKey: 'partId', rel: 'HAS' },
  item: { label: 'Item', idKey: 'itemId', rel: 'HOLDS' },
};
/** One relationship of the hub to one neighbor of the type; `n` tells the rows of a later page from the first. */
export const rowFor = (neighborType: string, n = 1): Record<string, unknown> => {
  const kind = KINDS[neighborType];
  if (kind === undefined) throw new Error(`no neighbor type ${neighborType}`);
  const neighbor = plainNode([kind.label], { [kind.idKey]: `${neighborType}-${n}` }, `e-${neighborType}-${n}`);
  return { a: hubNode, m: neighbor, rel: plainRelationship(kind.rel, hubNode, neighbor, { relId: `${neighborType}-r${n}` }, `rel-${neighborType}-${n}`), phase: 2, ts: null, id: `${neighborType}-r${n}`, rtype: kind.rel, dir: 'out', ntype: null, flag: null, members: null, first: null };
};

/** The stored edge of the hub to its first leaf, as an edge read of `EDGE_REF` finds it. */
const leafNode = plainNode(['Leaf'], { leafId: 'L-0' }, 'e-leaf-0');
const EDGE_ROW = { r: plainRelationship('LINKED', hubNode, leafNode, { relId: 'r-edge' }, 'rel-edge'), a: hubNode, b: leafNode };
export const EDGE_REF = { sourceId: SOURCE, type: 'LINKED', from: 'hub', to: 'leaf', stableId: 'r-edge' } as const;

/** What the scripted source does with the next expansion read: wait for the test, then answer. */
export interface Read {
  readonly call: ExecuteCall;
  readonly neighborType: string;
  /** Answers with this many relationships of the neighbor type (one by default); a read of another template answers with no rows. */
  answerRows(count?: number): void;
  /** Ends the read with the outcome: a timeout, an unavailable source. */
  fail(outcome: ExecuteOutcome): void;
}

/** A scripted source that holds every expansion read until the test says what it answers, and ends it as cancelled when its signal aborts, as the adapter does. */
function scriptedSource(mapping: ReturnType<typeof mappingWith>) {
  const reads: Read[] = [];
  const waiting: Array<(read: Read) => void> = [];
  let draining = false;
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return Promise.resolve(entityRows(hubNode));
    const neighborType = String(call.parameters['neighborType']);
    return new Promise<ExecuteOutcome>((resolve) => {
      const degrees = Object.fromEntries(Array.from({ length: DEGREE_COLUMNS }, (_, index) => [`c${index}`, 1]));
      const rows = (count: number): readonly Record<string, unknown>[] => (call.templateId === EXPAND_NEIGHBORS_ID ? Array.from({ length: count }, (_, index) => rowFor(neighborType, index + 1)) : call.templateId.startsWith('degree-preview') ? [degrees] : call.templateId === 'edge-load' ? [EDGE_ROW] : []);
      const read: Read = { call, neighborType, answerRows: (count = 1) => resolve({ status: 'rows', rows: rows(count) }), fail: resolve };
      call.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
      if (draining) return read.answerRows();
      const waiter = waiting.shift();
      if (waiter === undefined) reads.push(read);
      else waiter(read);
    });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  /** The next read of the source (an expansion or a degree preview) to reach the source (already there, or the next to come). */
  const nextRead = (): Promise<Read> => {
    const seen = reads.shift();
    return seen === undefined ? new Promise<Read>((resolve) => waiting.push(resolve)) : Promise.resolve(seen);
  };
  /** From now on every read answers with one relationship at once, so a request that should have stopped cannot be left waiting for a read nobody answers. */
  const drain = (): void => {
    draining = true;
    for (const read of reads.splice(0)) read.answerRows();
  };
  return { executor, nextRead, drain };
}

export interface Rig {
  readonly state: ClientState;
  readonly client: ApiClient;
  readonly expand: ExpandStore;
  readonly preview: PreviewStore;
  readonly derived: DerivedStore;
  readonly banner: ReturnType<typeof createBuiltInBannerController>;
  readonly tracker: ReturnType<typeof createRequestTracker>;
  readonly events: AuditEvent[];
  /** The investigations and drafts the API's app store holds. */
  readonly saved: () => string;
  /** Every request the web client sent: method and path. */
  readonly requests: string[];
  /** The body of each request the web client sent, in the same order. */
  readonly bodies: string[];
  /** What happened to the requests' trackers, in order: `finish` when a request's store ended it, `cancel` when the person's cancel took effect (a cancel after the finish does nothing and is not logged). */
  readonly order: string[];
  /** Each answer the web client received: status and parsed body. */
  readonly responses: Array<{ readonly status: number; readonly body: unknown }>;
  /** Moves the gate's clock forward, as time passing between the reads of one request. */
  advance(ms: number): void;
  /** Runs when the web client has the response headers of a request, and when it has read the whole body, before the client goes on. */
  readonly at: { afterHeaders?: () => void; afterBody?: () => void };
  /** Presses Cancel of the Running banner now, at once; false when no Running banner offers it. */
  cancelNow(): boolean;
  /** The banner on screen now, if any. */
  readonly showing: () => { readonly id: string; readonly headline: string; readonly actions: readonly string[] } | undefined;
  /** Waits until the Running banner shows, then presses its Cancel; the banner then shows Cancelled. */
  pressCancel(): Promise<void>;
  /** Everything the person has that a request must not change: see `snapshot` of this package. */
  snapshot(): string;
  readonly executor: RecordingExecutor;
  readonly nextRead: () => Promise<Read>;
  /** The read slots of the API: what is held and what waits, by person and by source. */
  readonly slots: ReturnType<typeof createReadSlots>;
  /** The node the cases expand. */
  readonly hub: ElementRef;
  /** Answers every later read at once; see the scripted source. */
  readonly drain: () => void;
  readonly logged: () => Record<string, unknown>[];
  /** The loaded graph before any request: the hub and one leaf. */
  readonly loaded: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] };
  close(): Promise<void>;
}

/** The real API (the gate, the read slots, an app store) on a loopback port, and the real web client, stores and banner in front of it, with a scripted source behind the gate. */
export async function startRig(options: { readonly delayMs?: number; readonly budgets?: Record<string, number> } = {}): Promise<Rig> {
  const mapping = mappingWith(options.budgets);
  const { executor, nextRead, drain } = scriptedSource(mapping);
  return startOn({ mapping, executor, hub: HUB, nextRead, drain, time: { now: 1_000_000 } }, options);
}

/** An executor that keeps the calls it was given. */
export interface RecordingExecutor extends ReadExecutor {
  readonly calls: readonly ExecuteCall[];
}

/** What stands behind the gate of a rig: a scripted source, or the real adapter on a Neo4j test database. */
export interface Backing {
  readonly mapping: ReturnType<typeof mappingWith>;
  readonly executor: RecordingExecutor;
  /** The node the cases expand. */
  readonly hub: ElementRef;
  readonly nextRead: () => Promise<Read>;
  readonly drain: () => void;
  readonly time: { now: number };
  /** The gate's own wiring, when the backing builds it; the rig builds one over `executor` otherwise. */
  readonly stop?: () => Promise<void>;
}

export async function startOn(backing: Backing, options: { readonly delayMs?: number }): Promise<Rig> {
  const { mapping, executor, nextRead, drain, time } = backing;
  const webRoot = makeWebRoot();
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const slots = createReadSlots();
  const seams = { policy: defaults.policy, coordinator: slots, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const verdicts = createUsabilityRecord();
  verdicts.observe({ sourceId: backing.hub.sourceId, checkedAt: '2026-11-02T10:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' }, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
  const parts = assembleGate({ mapping, seams, executor, logger: { warn: () => undefined }, clock: () => time.now });
  const lines: string[] = [];
  const store = memoryAppStore();
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store, mapping, gate: parts.gate, seams, degreeVerdicts: verdicts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${portOf(app)}`;
  const requests: string[] = [];
  const bodies: string[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const at: Rig['at'] = {};
  const client = createApiClient(async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`);
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const response = await fetch(`${base}${input}`, init as RequestInit);
    at.afterHeaders?.();
    const text = await response.text();
    responses.push({ status: response.status, body: (() => { try { return JSON.parse(text) as unknown; } catch { return text; } })() });
    at.afterBody?.();
    return new Response(text, { status: response.status, headers: response.headers });
  });

  const state = createClientState();
  const SOURCE_ID = backing.hub.sourceId;
  const hubNodeOfWeb: GraphNode = { ...node(SOURCE_ID, backing.hub.stableId), ref: backing.hub, display: { title: backing.hub.stableId, type: backing.hub.entityType } };
  const leaf: GraphNode = { ...node(SOURCE_ID, 'L-0'), ref: ref(SOURCE_ID, 'leaf', 'L-0'), display: { title: 'L-0', type: 'leaf' } };
  const loaded = { nodes: [hubNodeOfWeb, leaf], edges: [edge(SOURCE_ID, 'r0', backing.hub.stableId, 'L-0')] };
  const opened = await openEntity(client, state, { sourceId: SOURCE_ID, entity: backing.hub }, { principalId: 'person-1', mask: false });
  if (opened.kind !== 'shown') throw new Error(`the rig could not open its investigation: ${opened.kind}`);
  const held = state.investigation.getState();
  const extra = key(SOURCE_ID, 'seed-2');
  state.putResult(extra, { sourceId: SOURCE_ID, nodes: [leaf], edges: [...loaded.edges] });
  state.setLoaded([...held.resultKeys, extra], [...held.nodeRefs, leaf.ref], [...held.edgeRefs, ...loaded.edges.map((each) => each.ref)]);

  requests.length = 0;
  bodies.length = 0;
  responses.length = 0;
  events.length = 0;
  lines.length = 0;
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const report = bannerReporter(banner, () => 'Demo source');
  const order: string[] = [];
  const real = createRequestTracker(banner, {
    titleOf: (target) => target.stableId,
    timeoutOf: () => 5000,
    delayMs: options.delayMs ?? 0,
  });
  const tracker: typeof real = {
    ...real,
    begin: (call) => {
      const tracked = real.begin({ ...call, cancel: () => (order.push('cancel'), call.cancel()) });
      return {
        get cancelled() {
          return tracked.cancelled;
        },
        finish: () => (order.push('finish'), tracked.finish()),
      };
    },
  };
  const expand = createExpandStore(client, state, () => 'person-1', report, undefined, tracker);
  const preview = createPreviewStore(client, () => 'person-1', report, tracker);
  const derived = createDerivedStore(client, state, () => 'person-1', () => state.investigation.getState().id ?? '');
  const showing = () => {
    const current = banner.view.getState().banner;
    return current === undefined ? undefined : { id: current.id, headline: current.headline, actions: current.actions.map((action) => action.id) };
  };
  const snapshot = (): string => {
    // the store's own view of a node it was never asked about is idle, so each loaded node is read through `of`, the store's account of what it holds
    const progress = state.loadedGraph().nodes.map((each) => {
      const held = expand.of(each.ref);
      return [elementKey(each.ref), held.pageSize, held.chosenPageSize, [...held.types].map(([type, p]) => [type, p.loaded, p.hasMore, p.cursor, p.restartNeeded])];
    });
    const plain = (_: string, value: unknown): unknown => (value instanceof Set ? ['Set', ...value] : value instanceof Map ? ['Map', ...value] : value);
    return JSON.stringify({ investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), graph: state.loadedGraph(), progress, saved: saved() }, plain);
  };
  const saved = (): string => JSON.stringify({ investigations: store.investigations, drafts: store.drafts });
  const cancelNow = (): boolean => {
    const action = banner.view.getState().banner?.actions.find((each) => each.id === 'cancel');
    action?.run();
    return action !== undefined;
  };
  const pressCancel = async (): Promise<void> => {
    for (let waited = 0; waited < 3000 && !(showing()?.actions ?? []).includes('cancel'); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    const action = banner.view.getState().banner?.actions.find((each) => each.id === 'cancel');
    if (action === undefined) throw new Error('the Running banner never offered Cancel');
    action.run();
  };
  return {
    state, client, expand, preview, derived, banner, tracker, events, executor, nextRead, drain, loaded, hub: backing.hub, slots, saved, requests, bodies, order, at, cancelNow, responses, advance: (ms: number) => void (time.now += ms), showing, pressCancel, snapshot,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
      await backing.stop?.();
    },
  };
}

/** Waits until the check holds, for at most two seconds. */
export async function until(check: () => boolean, what = 'the condition'): Promise<void> {
  for (let waited = 0; !check() && waited < 2000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/** A person's work on the loaded graph: one leaf selected and one hidden. */
export function personalise(rig: Rig): void {
  const [, leaf] = rig.loaded.nodes;
  if (leaf === undefined) throw new Error('no leaf loaded');
  rig.state.presentation.select([elementKey(leaf.ref)]);
  rig.state.hide([elementKey(leaf.ref)]);
  rig.state.presentation.select([elementKey(rig.hub)]);
}
