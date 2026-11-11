import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { AggregateEdgeRef, DerivedEdgeRef, EdgeRef, ElementRef, GraphEdge, GraphNode, LayoutDocument, QueryContextDocument } from '@neburyx/contracts';
import { createApiClient, type ApiClient } from '../../../apps/web/src/api/client.js';
import { AUTOSAVE_DELAY_MS, draftSyncOf, type DraftSync } from '../../../apps/web/src/draft/draft-sync.js';
import { openById, openEntity, type OpenOutcome } from '../../../apps/web/src/investigations/open-flow.js';
import { createClientState, type ClientState } from '../../../apps/web/src/state/client-state.js';
import { elementKey } from '../../../apps/web/src/state/keys.js';
import { key } from '../../../apps/web/src/state/test-data.js';
import { buildApp, registeredRoutesOf } from '../../../services/api/src/app.js';
import { createAppStore, type AppStore } from '../../../services/api/src/app-store.js';
import { rows } from '../../../services/api/src/testing/database.js';
import { runCli } from '../../../services/api/src/testing/cli.js';
import type { TestDatabase, TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { createExportFileStore, type ExportFileStore } from '../../../services/api/src/exports/store.js';
import { assembleGate } from '../../../services/api/src/gate/assemble.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../../../services/api/src/gate/executor.js';
import { createUsabilityRecord } from '../../../services/api/src/source-test/usability.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import type { MappingModel } from '../../../services/api/src/mapping/model.js';
import { memoryStoreWith, type MemoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { plainNode, plainRelationship } from '../../../services/api/src/testing/normalize-fixtures.js';
import { portOf } from '../../../services/api/src/testing/raw-request.js';
import { withOnlineIndexes } from '../../../services/api/src/testing/search-fixtures.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';

export const SOURCE = 'demo';

/** The verdicts the checks of a real install leave once they have shown every type's degree to be cheap, so a preview of an entity's relationships gives a count and an export can state it. */
function cheapDegrees() {
  const record = createUsabilityRecord();
  const cheap = (entityType: string, relationshipTypes: string[]) => ({ entityType, result: 'cheap' as const, basis: 'degree-operator' as const, relationshipTypes });
  record.observe({ sourceId: SOURCE, checkedAt: '2026-11-02T10:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' }, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'pass', foundOn: 'a synthetic server', types: [cheap('hub', ['LINKED', 'HAS']), cheap('leaf', ['LINKED']), cheap('part', ['HAS'])], warnings: [] } });
  return record;
}
/** A stored relationship's reference, the kind `read-refs` takes in `edges`. */
export type StoredEdgeRef = Extract<EdgeRef, { stableId: string }>;
export const CONTEXT = { principalId: 'person-1', mask: false } as const;

export const ENTITY_TYPES = [
  { type: 'hub', label: 'Hub', stable_id: 'hubId' },
  { type: 'leaf', label: 'Leaf', stable_id: 'leafId', filterable: ['weight'] },
  { type: 'part', label: 'Part', stable_id: 'partId' },
];
export const RELATIONSHIP_TYPES = [
  { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' },
  { type: 'HAS', from: 'hub', to: 'part', stable_id: 'relId' },
];

/** The mapping of the suite's source; `without` leaves some entity types out, and `weight` says what the leaf's `weight` property is: filterable (the default), no longer in the mapping, or personal data. */
export function mappingOf(options: { readonly without?: readonly string[]; readonly database?: string; readonly weight?: 'filterable' | 'removed' | 'personal' } = {}): MappingModel {
  const gone = options.without ?? [];
  const weight = options.weight ?? 'filterable';
  const entityTypes = ENTITY_TYPES.map((each) => (each.type !== 'leaf' ? each : weight === 'removed' ? { type: each.type, label: each.label, stable_id: each.stable_id } : weight === 'personal' ? { ...each, filterable: [], pii: [{ property: 'weight', class: 'text' }] } : each));
  return parseMapping(
    fileOf(
      baseSource({
        id: SOURCE,
        database: options.database ?? 'neo4j',
        entities: entityTypes.filter((each) => !gone.includes(each.type)),
        relationships: RELATIONSHIP_TYPES.filter((each) => !gone.includes(each.from) && !gone.includes(each.to)),
      }),
    ),
    'neburyx.yaml',
  );
}

export const ref = (entityType: string, stableId: string): ElementRef => ({ sourceId: SOURCE, entityType, stableId });

const LABELS: Readonly<Record<string, { label: string; idKey: string }>> = { hub: { label: 'Hub', idKey: 'hubId' }, leaf: { label: 'Leaf', idKey: 'leafId' }, part: { label: 'Part', idKey: 'partId' } };
const RELATIONSHIPS: Readonly<Record<string, string>> = { LINKED: 'LINKED', HAS: 'HAS' };

/** The graph the scripted source holds: the entities and stored relationships the cases name. */
export class World {
  readonly entities = new Map<string, ReturnType<typeof plainNode>>();
  readonly edges = new Map<string, { readonly type: string; readonly row: Record<string, unknown> }>();

  entity(entityType: string, stableId: string): this {
    const kind = LABELS[entityType];
    if (kind === undefined) throw new Error(`no entity type ${entityType}`);
    this.entities.set(`${entityType}\u0000${stableId}`, plainNode([kind.label], { [kind.idKey]: stableId }, `e-${entityType}-${stableId}`));
    return this;
  }

  /** A stored relationship of `type` between two entities of the world. */
  relationship(type: string, from: readonly [string, string], to: readonly [string, string], stableId: string): this {
    const start = this.entities.get(`${from[0]}\u0000${from[1]}`);
    const end = this.entities.get(`${to[0]}\u0000${to[1]}`);
    if (start === undefined || end === undefined || RELATIONSHIPS[type] === undefined) throw new Error('the relationship names an entity or a type the world does not hold');
    this.edges.set(stableId, { type, row: { r: plainRelationship(type, start, end, { relId: stableId }, `rel-${stableId}`), a: start, b: end } });
    return this;
  }

  remove(entityType: string, stableId: string): this {
    this.entities.delete(`${entityType}\u0000${stableId}`);
    return this;
  }

  answer(call: ExecuteCall): ExecuteOutcome {
    if (call.templateId === 'entity-load') {
      const label = /\(n:`([^`]+)`\)/.exec(call.cypher)?.[1];
      const entityType = Object.entries(LABELS).find(([, kind]) => kind.label === label)?.[0];
      const found = this.entities.get(`${String(entityType)}\u0000${String(call.parameters['stableId'])}`);
      return found === undefined ? { status: 'rows', rows: [] } : entityRows(found);
    }
    if (call.templateId === 'entity-load-many') {
      const label = /\(n:`([^`]+)`\)/.exec(call.cypher)?.[1];
      const entityType = Object.entries(LABELS).find(([, kind]) => kind.label === label)?.[0];
      const refs = call.parameters['refs'] as readonly { readonly stableId: string }[];
      return { status: 'rows', rows: refs.flatMap((each, i) => { const found = this.entities.get(`${String(entityType)}\u0000${each.stableId}`); return found === undefined ? [] : [{ i, n: found, dup: false }]; }) };
    }
    if (call.templateId === 'edge-load-many') {
      const refs = call.parameters['refs'] as readonly { readonly stableId: string }[];
      return { status: 'rows', rows: refs.flatMap((each, i) => { const found = this.edges.get(each.stableId); return found === undefined ? [] : [{ i, dup: false, ...found.row }]; }) };
    }
    if (call.templateId === 'edge-load') {
      const found = this.edges.get(String(call.parameters['stableId']));
      return found === undefined ? { status: 'rows', rows: [] } : { status: 'rows', rows: [found.row] };
    }
    return { status: 'rows', rows: [] };
  }
}

/** The small graph most cases start from: a hub with five leaves and two parts. */
export function defaultWorld(): World {
  const world = new World().entity('hub', 'H-1');
  for (let at = 1; at <= 5; at += 1) world.entity('leaf', `L-${at}`).relationship('LINKED', ['hub', 'H-1'], ['leaf', `L-${at}`], `r-L${at}`);
  for (let at = 1; at <= 2; at += 1) world.entity('part', `P-${at}`).relationship('HAS', ['hub', 'H-1'], ['part', `P-${at}`], `r-P${at}`);
  return world;
}

/** The page events the draft sync listens to, which Node has none of. */
class PageStub {
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

/** One browser tab: its own client state, draft sync and request log, in front of the suite's API. */
export interface Tab {
  readonly state: ClientState;
  readonly client: ApiClient;
  readonly sync: DraftSync;
  /** Every request this tab sent: method and path. */
  readonly requests: string[];
  /** The requests this tab sent with `keepalive`, which the browser lets outlive the page. */
  readonly keepalives: string[];
  /** The draft writes this tab sent. */
  draftWrites(): string[];
  /** The text of every response this tab received, in order. */
  readonly bodies: string[];
  open(entityRef: ElementRef, caseRef?: string): Promise<OpenOutcome>;
  openById(id: string): Promise<OpenOutcome>;
  /** Reads items by reference, as the web does when it adds them, and adds them to the loaded graph. */
  load(entities: readonly ElementRef[], edges?: readonly StoredEdgeRef[], more?: { readonly aggregates?: readonly AggregateEdgeRef[]; readonly derived?: readonly DerivedEdgeRef[] }): Promise<void>;
  /** Tells the tab which types the mapping names, as the profile does when the workspace opens. */
  mapTypes(entityTypes: readonly string[], relationshipTypes: readonly string[]): void;
  /** What a person has made of the investigation, as one plain document: the loaded items, positions, pins, hidden items, the layout, the viewport and the type filter. */
  canonical(): string;
  nodeKey(entityType: string, stableId: string): string;
  /** The requests this tab sent to a route that reads the source. */
  sourceReads(): string[];
  /** Waits until nothing of the draft is waiting or being written. */
  written(): Promise<void>;
  dispose(): void;
}

/** The draft the store holds, with its documents typed. */
export interface StoredDraft {
  readonly version: number;
  readonly notes: string | null;
  readonly basedOnViewId: string | null;
  readonly mappingHash: string;
  readonly layout: LayoutDocument;
  readonly queryContext: QueryContextDocument;
}

/** An executor that keeps the calls it was given. */
export interface RecordingExecutor extends ReadExecutor {
  readonly calls: readonly ExecuteCall[];
}

/** What the cases do with a running suite, whatever store is behind it. */
export interface Running {
  readonly world: World;
  /** Where the API keeps export files, and the store over it. */
  readonly exportDirectory: string;
  readonly exportFiles: ExportFileStore;
  readonly executor: RecordingExecutor;
  readonly page: PageStub;
  tab(): Tab;
  dataReads(): ExecuteCall[];
  advance(ms: number): Promise<void>;
  until(check: () => boolean, what?: string): Promise<void>;
  restart(mapping: MappingModel): Promise<void>;
  routes(): string[];
  close(): Promise<void>;
}

export interface Suite extends Running {
  /** The first draft the store holds. */
  draft(): StoredDraft | undefined;
  readonly store: MemoryAppStore;
}

/** The stable ids the calls asked the source for by reference, one by one or in a list. */
export function idsRead(calls: readonly ExecuteCall[]): string[] {
  return calls.flatMap((call) => {
    if (call.templateId === 'entity-load-many' || call.templateId === 'edge-load-many') return (call.parameters['refs'] as readonly { readonly stableId: string }[]).map((each) => each.stableId);
    return call.templateId === 'entity-load' || call.templateId === 'edge-load' ? [String(call.parameters['stableId'])] : [];
  });
}

export const SOURCE_READ = /^(GET|POST) \/v1\/(graph|entities|search|edges|source-links)\//;
/** The reads the gate asks before a data read, which no case counts: the list of indexes and tokens, and what the login may do. */
const NOT_DATA_READS = /^(schema-|capabilities|privileges)/;

export interface SuiteOptions {
  readonly executorOf?: (mapping: MappingModel) => ReadExecutor;
  readonly mapping?: MappingModel;
  readonly world?: World;
  readonly store?: MemoryAppStore;
  /** What the source answers before the world does; undefined passes the call on. */
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome | undefined;
}

interface BuildOptions {
  readonly mapping?: MappingModel;
  readonly world?: World;
  readonly store: AppStore;
  readonly answer?: SuiteOptions['answer'];
  /** True for a store that keeps the sources of the mapping in a table: the API writes them at every start. */
  readonly syncSources?: boolean;
  /** A source of its own behind the gate, in place of the scripted one: the real adapter on a test database. */
  readonly executorOf?: (mapping: MappingModel) => ReadExecutor;
}

async function build(options: BuildOptions): Promise<Running> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const page = new PageStub();
  (globalThis as { window?: unknown }).window = page;
  const world = options.world ?? defaultWorld();
  const { store } = options;
  const tabs: Tab[] = [];
  const webRoot = makeWebRoot();
  const exportDirectory = join(mkdtempSync(join(tmpdir(), 'nbx-save-suite-exports-')), 'exports');
  mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
  const exportFiles = createExportFileStore(exportDirectory);
  const executors: RecordingExecutor[] = [];
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let base = '';
  let executor: RecordingExecutor;

  const start = async (mapping: MappingModel): Promise<void> => {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    if (options.syncSources === true) await store.syncSources(mapping.sources);
    let gate;
    if (options.executorOf === undefined) {
      const scripted = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(options.answer?.(call) ?? world.answer(call))));
      executor = scripted;
      gate = testSourceGate(mapping, { executor: scripted }).gate;
    } else {
      const inner = options.executorOf(mapping);
      const calls: ExecuteCall[] = [];
      executor = { calls, execute: (call) => (calls.push(call), inner.execute(call)) };
      const defaults = communitySeams();
      gate = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined } }).gate;
    }
    executors.push(executor);
    // the application closes the store it is given; a restart opens the next application over the same store, so the suite closes it itself
    app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: { ...store, close: () => Promise.resolve() }, mapping, gate, exportFiles, degreeVerdicts: cheapDegrees() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${portOf(app)}`;
  };
  const stop = async (): Promise<void> => {
    if (app === undefined) return;
    app.server.closeAllConnections();
    await app.close();
    app = undefined;
  };
  const release = (): void => {
    rmSync(webRoot, { recursive: true, force: true });
    rmSync(join(exportDirectory, '..'), { recursive: true, force: true });
    delete (globalThis as { window?: unknown }).window;
    vi.useRealTimers();
  };
  try {
    await start(options.mapping ?? mappingOf());
  } catch (error) {
    await stop().catch(() => undefined);
    release();
    throw error;
  }

  const until = async (check: () => boolean, what = 'the condition'): Promise<void> => {
    // the clock is real (only the timers are faked), so a slow database is waited for, not counted out
    for (const deadline = Date.now() + 15_000; !check() && Date.now() < deadline; ) await new Promise((resolve) => setImmediate(resolve));
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  };

  const suite: Running = {
    world,
    exportDirectory,
    exportFiles,
    get executor() {
      return executor;
    },
    page,
    tab() {
      const requests: string[] = [];
      const bodies: string[] = [];
      const keepalives: string[] = [];
      const client = createApiClient(async (input, init) => {
        requests.push(`${init?.method ?? 'GET'} ${input}`);
        if ((init as RequestInit | undefined)?.keepalive === true) keepalives.push(`${init?.method ?? 'GET'} ${input}`);
        const response = await fetch(`${base}${input}`, init as RequestInit);
        bodies.push(await response.clone().text());
        return response;
      });
      const state = createClientState();
      const sync = draftSyncOf(state, client);
      let extras = 0;
      const tab: Tab = {
        state,
        client,
        sync,
        requests,
        bodies,
        keepalives,
        draftWrites: () => requests.filter((request) => /^PUT \/v1\/investigations\/[^/]+\/draft$/.test(request)),
        open: (entityRef, caseRef) => openEntity(client, state, { sourceId: SOURCE, entity: entityRef, ...(caseRef === undefined ? {} : { caseRef }) }, CONTEXT),
        openById: (id) => openById(client, state, id, CONTEXT),
        async load(entities, edges = [], more = {}) {
          const read = await client.readRefs({ sourceId: SOURCE, entities: [...entities], edges: [...edges], aggregates: [...(more.aggregates ?? [])], derived: [...(more.derived ?? [])] });
          if (!read.ok) throw new Error(`the read by reference failed: ${read.failure.code}`);
          extras += 1;
          const held = state.investigation.getState();
          const extra = key(SOURCE, `extra-${extras}`);
          state.putResult(extra, { sourceId: SOURCE, nodes: read.value.nodes as GraphNode[], edges: read.value.edges as GraphEdge[] });
          state.setLoaded([...held.resultKeys, extra], [...held.nodeRefs, ...read.value.nodes.map((node) => node.ref)], [...held.edgeRefs, ...read.value.edges.map((edge) => edge.ref)]);
        },
        mapTypes: (entityTypes, relationshipTypes) => state.presentation.setMappedTypes({ entityTypes, relationshipTypes }),
        canonical: () => {
          const view = state.presentation.view.getState();
          const graph = state.loadedGraph();
          const sorted = (values: Iterable<string>) => [...values].sort();
          return JSON.stringify({
            nodes: sorted(graph.nodes.map((node) => elementKey(node.ref))),
            edges: sorted(graph.edges.map((edge) => JSON.stringify(edge.ref))),
            positions: sorted([...view.positions].map(([at, position]) => JSON.stringify([at, position.x, position.y]))),
            pins: sorted(view.pins),
            hidden: sorted(view.hidden),
            layout: view.layout,
            viewport: view.viewport ?? null,
            typeFilter: { entityTypes: sorted(view.typeFilter.offEntityTypes), relationshipTypes: sorted(view.typeFilter.offRelationshipTypes) },
          });
        },
        nodeKey: (entityType, stableId) => elementKey(ref(entityType, stableId)),
        sourceReads: () => requests.filter((request) => SOURCE_READ.test(request)),
        written: () => until(() => !sync.needsSettle(), 'the draft to be written'),
        dispose: () => sync.dispose(),
      };
      tabs.push(tab);
      return tab;
    },
    routes: () => (app === undefined ? [] : registeredRoutesOf(app).map((route) => `${route.method} ${route.url}`)),
    dataReads: () => executors.flatMap((each) => each.calls.filter((call) => !NOT_DATA_READS.test(call.templateId))),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    until,
    restart: async (mapping) => {
      await stop();
      await start(mapping);
    },
    close: async () => {
      try {
        for (const tab of tabs) tab.dispose();
        await stop();
      } finally {
        release();
      }
    },
  };
  return suite;
}

export async function startSuite(options: SuiteOptions = {}): Promise<Suite> {
  const store = options.store ?? memoryStoreWith({ sources: [SOURCE, 'other'].map((id) => ({ id, alias: id, state: 'unknown' as const, stateReason: null, synthetic: false, lastTestAt: null })) });
  const running = await build({ ...options, store });
  return Object.assign(running, { store, draft: () => store.drafts[0] as StoredDraft | undefined });
}

/** A suite over real Postgres: the API's own store on a database of its own, migrated as an install is. */
export interface PgSuite extends Running {
  readonly store: AppStore;
  readonly database: TestDatabase;
  /** Runs a statement as the owner of the database, for what no route can do: moving a date, reading a column. */
  sql(query: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** The first draft the database holds. */
  draft(): Promise<StoredDraft | undefined>;
}

const SHIPPED = fileURLToPath(new URL('../../../services/api/migrations', import.meta.url));
const pgStores: AppStore[] = [];

/** Closes every store the suites opened; a file calls it once when it is done. */
export async function closePgStores(): Promise<void> {
  await Promise.all(pgStores.splice(0).map((store) => store.close()));
}

export async function startPgSuite(postgres: TestPostgres, options: Omit<SuiteOptions, 'store'> = {}): Promise<PgSuite> {
  const database = await postgres.newDatabase();
  const migrated = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  if (migrated.code !== 0) throw new Error('the database was not migrated');
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  pgStores.push(store);
  await store.initialize();
  const running = await build({ ...options, store, syncSources: true });
  const sql = (query: string, parameters: readonly unknown[] = []) => rows(database.ownerUrl, query, parameters);
  const draft = async (): Promise<StoredDraft | undefined> => {
    const [row] = await sql(`SELECT version, notes, based_on_view_id, mapping_hash, layout, query_context FROM saved_views WHERE kind = 'draft'`);
    return row === undefined ? undefined : { version: Number(row['version']), notes: row['notes'] as string | null, basedOnViewId: row['based_on_view_id'] as string | null, mappingHash: String(row['mapping_hash']), layout: row['layout'] as LayoutDocument, queryContext: row['query_context'] as QueryContextDocument };
  };
  return Object.assign(running, { store, database, sql, draft });
}

export { AUTOSAVE_DELAY_MS };
