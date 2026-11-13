import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { createPatterns } from './support-patterns.ts';
import { exportRequestSchema, IDEMPOTENCY_KEY_PATTERN, deleteViewRequestSchema, restoreInvestigationRequestSchema, DEFAULT_INVESTIGATION_LIST_LIMIT, DEFAULT_VIEW_PAGE, MAX_INVESTIGATION_LIST_LIMIT, MAX_VIEW_PAGE, viewListQuerySchema, parseEdgeRefSegment, renameRequestSchema, renameViewRequestSchema, saveViewRequestSchema, statusChangeRequestSchema, investigationListCountsSchema, nodeSchema, investigationListQuerySchema, type Investigation, type LastTest, openInvestigationRequestSchema, SEARCH_GROUP_CAP, searchMoreRequestSchema, searchMoreResultSchema, searchRequestSchema, searchResultSchema, type SourceSummary, sourceSummaryFieldsSchema, sourceSummarySchema, type SourceTestReport, type EdgeReadRef, valueOfPathSegment } from '@neburyx/contracts';

interface SupportProfile {
  readonly sourceId: string;
  readonly presets?: readonly unknown[];
  readonly entityTypes?: readonly { readonly type: string }[];
}

export interface SupportServerOptions {
  /** The folder of a built web app. */
  readonly root: string;
  /** The synthetic source profile the pages read; its `sourceId` names the source the server lists, and its entity types are the ones an investigation can start from. */
  readonly profile: SupportProfile;
  readonly otherProfiles?: readonly SupportProfile[];
  readonly refusedSources?: readonly string[];
}

const profilesOf = (options: SupportServerOptions): readonly SupportProfile[] => [options.profile, ...(options.otherProfiles ?? [])];

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.md': 'text/markdown; charset=utf-8',
};

const API_PREFIX = '/v1';
const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

function json(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function me(sourceIds: readonly string[]): unknown {
  return {
    principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' },
    edition: 'community',
    identityMode: 'none',
    sources: sourceIds.map((sourceId) => ({ sourceId, viewSensitive: false, synthetic: true })),
  };
}

const SOURCE_SUMMARY = { state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 4, relationshipTypes: 6, derivedRules: 2 }, demoCase: null, maxHops: 4 } as const;

type SourceChange = Partial<Omit<SourceSummary, 'id'>>;

function lastTestOf(report: SourceTestReport): LastTest {
  return {
    checkedAt: report.checkedAt,
    outcome: report.outcome,
    server: report.server === null ? null : { product: report.server.product, version: report.server.version },
    versionSupported: report.versionSupported,
    readOnlyCheck: report.readOnlyCheck,
    loginCanWrite: report.loginCanWrite,
    degreeStatus: report.degreeChecks.status,
    degreeWarnings: [...report.degreeChecks.warnings],
  };
}

function testReportOf(sourceId: string, summary: SourceSummary): SourceTestReport {
  return {
    schemaVersion: 1,
    sourceId,
    checkedAt: new Date().toISOString(),
    outcome: 'pass',
    state: 'connected',
    stateReason: null,
    server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
    versionSupported: true,
    operations: [],
    readOnlyCheck: 'privileges-inspected',
    loginCanWrite: false,
    mappingChecks: { status: 'pass', findings: [] },
    degreeChecks: { status: 'pass', foundOn: 'neo4j', types: [{ entityType: 'thing', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['LINKS'] }], warnings: [] },
    mappingSummary: summary.mappingSummary,
  };
}

/**
 * The sources the pages list. A source is connected and never tested until a spec changes it through `POST /__support/sources`
 * (a map of source ID to the fields to change), runs its test through `POST /v1/sources/{id}/test`, which stores the report as the
 * source's last test, or asks for the sources read that follows a test to wait (`POST /__support/hold-after-test`) until
 * `POST /__support/release`. `POST /__support/reset` undoes all three.
 */
function createSources(options: SupportServerOptions) {
  const known = profilesOf(options).map((profile) => profile.sourceId);
  let changes = new Map<string, SourceChange>();
  let holdAfterTest = false;
  let holding = false;
  let waiting: Array<() => void> = [];
  const summaryOf = (sourceId: string): SourceSummary => ({ id: sourceId, alias: sourceId, ...SOURCE_SUMMARY, ...changes.get(sourceId) });
  const release = (): void => {
    holding = false;
    for (const resume of waiting) resume();
    waiting = [];
  };
  return {
    async list(response: ServerResponse): Promise<void> {
      if (holding) await new Promise<void>((resume) => waiting.push(resume));
      json(response, 200, { items: known.map(summaryOf), nextCursor: null });
    },
    test(sourceId: string, response: ServerResponse): void {
      if (!known.includes(sourceId)) return json(response, 404, NOT_FOUND);
      const report = testReportOf(sourceId, summaryOf(sourceId));
      const lastTest = lastTestOf(report);
      changes.set(sourceId, { ...changes.get(sourceId), state: report.state, stateReason: report.stateReason, lastTest, lastTestAt: lastTest.checkedAt });
      if (holdAfterTest) holding = true;
      json(response, 200, report);
    },
    control(path: string, body: unknown, response: ServerResponse): void {
      if (path === '/__support/reset') {
        changes = new Map();
        holdAfterTest = false;
        release();
        return json(response, 200, {});
      }
      if (path === '/__support/hold-after-test') {
        holdAfterTest = true;
        return json(response, 200, {});
      }
      if (path === '/__support/release') {
        release();
        return json(response, 200, {});
      }
      if (path !== '/__support/sources' || typeof body !== 'object' || body === null || Array.isArray(body)) return json(response, 404, NOT_FOUND);
      const next = new Map<string, SourceChange>();
      for (const [sourceId, change] of Object.entries(body)) {
        const parsed = sourceSummaryFieldsSchema.omit({ id: true }).partial().safeParse(change);
        if (!known.includes(sourceId) || !parsed.success || !sourceSummarySchema.safeParse({ id: sourceId, alias: sourceId, ...SOURCE_SUMMARY, ...parsed.data }).success) return json(response, 400, INVALID);
        next.set(sourceId, parsed.data);
      }
      changes = next;
      json(response, 200, {});
    },
  };
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-support' } };
const MISMATCH = { error: { code: 'SOURCE_MISMATCH', message: 'The request mixes more than one source.', retryable: false, traceId: 'tr-support' } };
/** The synthetic answer for a stored edge: two ends named after their entity types and one source record (none for a stable ID that starts with `legacy`). */
function edge(ref: EdgeReadRef | undefined, response: ServerResponse): void {
  if (ref === undefined) return json(response, 400, INVALID);
  if ('derived' in ref) return json(response, 404, NOT_FOUND);
  if ('aggregate' in ref) return aggregateEdge(ref, response);
  const end = (entityType: string) => ({ ref: { sourceId: ref.sourceId, entityType, stableId: `${entityType}-1` }, title: `${entityType}-1`, type: entityType });
  const records = ref.stableId.startsWith('legacy') ? undefined : [{ sourceRecordId: `REC-${ref.stableId}`, linkable: false }];
  return json(response, 200, {
    ref,
    type: ref.type,
    semantics: 'stored',
    from: end(ref.from),
    to: end(ref.to),
    observedAt: '2026-10-21T08:15:00Z',
    properties: [],
    qualityFlags: [],
    evidence: records === undefined ? { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } : { status: 'available', records },
  });
}

/** The synthetic answer for an aggregate: three members, an observed range and two sampled members newest first. */
function aggregateEdge(ref: Extract<EdgeReadRef, { aggregate: unknown }>, response: ServerResponse): void {
  const end = (entity: { readonly entityType: string; readonly stableId: string }) => ({ ref: { sourceId: ref.sourceId, entityType: entity.entityType, stableId: entity.stableId }, title: entity.stableId, type: entity.entityType });
  return json(response, 200, {
    ref,
    type: ref.aggregate.type,
    semantics: 'aggregate',
    from: end(ref.aggregate.from),
    to: end(ref.aggregate.to),
    members: { value: 3, quality: 'exact', scope: 'aggregate:members' },
    observedFirst: '2026-01-01T10:00:00Z',
    observedLast: '2026-01-03T10:00:00Z',
    sample: { order: 'observed-newest', rows: [3, 2].map((day) => ({ observedAt: `2026-01-0${day}T10:00:00Z`, properties: [] })), more: 1 },
    qualityFlags: [],
    warnings: [],
  });
}

const PLAIN_CONFLICT = { error: { code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.', retryable: false, traceId: 'tr-support' } };

function readOnlyRefusal(status: 'closed' | 'archived'): unknown {
  return { error: { code: 'CONFLICT', message: 'This investigation is closed or archived. Reopen it to make changes.', retryable: false, traceId: 'tr-support', details: { reason: 'investigation-read-only', status } } };
}

const RETENTION_DAYS = 30;

const INVALID = { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } };

/** A named view the stand-in holds: what the list shows, and the draft it was saved from. */
interface StoredView {
  readonly id: string;
  name: string;
  readonly notes: string | null;
  readonly createdAt: string;
  version: number;
  readonly layout: unknown;
  readonly queryContext: unknown;
  /** Set when the view was deleted: it is left out of every read and cannot be restored. */
  deletedNote?: string | null;
  deleted?: boolean;
}

const viewShown = (view: StoredView): unknown => ({ id: view.id, name: view.name, notes: view.notes, savedBy: { name: 'Support analyst' }, createdAt: view.createdAt, version: view.version });

interface StoredInvestigation {
  title: string;
  status: Investigation['status'];
  version: number;
  draftVersion: number;
  draftLayout?: unknown;
  draftQueryContext?: unknown;
  draftNotes: string | null;
  basedOnViewId: string | null;
  views: StoredView[];
  lastEditedAt: string;
  readonly id: string;
  readonly sourceId: string;
  readonly caseRef: string | null;
  readonly entityType: string;
  readonly stableId: string;
  readonly createdAt: string;
  /** Set when the investigation was deleted: it is reachable by restore only until `purgeAfter`. */
  deleted?: { readonly at: string; readonly purgeAfter: string };
}

function node(sourceId: string, entityType: string, stableId: string): unknown {
  return {
    ref: { sourceId, entityType, stableId },
    display: { title: `${entityType} ${stableId}`, type: entityType },
    properties: [],
    qualityFlags: stableId.startsWith(DUPLICATE_ID_PREFIX) ? ['duplicate-stable-id'] : [],
    provenanceRefs: [],
    authorization: { canInspect: true, canExport: true },
  };
}

/** An entity whose ID starts with this is read with the quality flag of an ID that the source holds twice. */
const DUPLICATE_ID_PREFIX = 'dup-';

/** An investigation opened with a case reference that starts with this is new when it is opened, and once it exists reads back, and is resumed, as one whose source now points at another database. */
const REPOINTED_CASE_REF = 'repointed';
const isRepointed = (caseRef: string | null): boolean => caseRef?.startsWith(REPOINTED_CASE_REF) === true;
/** The same for a source that is no longer configured. */
const REMOVED_CASE_REF = 'removed';
const isRemoved = (caseRef: string | null): boolean => caseRef?.startsWith(REMOVED_CASE_REF) === true;

function sourceStateOf(stored: StoredInvestigation, isNew: boolean): Investigation['sourceState'] {
  if (isNew) return 'available';
  return isRepointed(stored.caseRef) ? 'repointed' : isRemoved(stored.caseRef) ? 'removed' : 'available';
}

/** What a write to an investigation is refused with: closed or archived first, then a source that changed. */
function writeRefusal(stored: StoredInvestigation): unknown {
  if (stored.status !== 'open') return readOnlyRefusal(stored.status);
  const sourceState = sourceStateOf(stored, false);
  if (sourceState === 'available') return undefined;
  return { error: { code: 'CONFLICT', message: 'This source now points to a different database or is no longer configured. This investigation is read-only.', retryable: false, traceId: 'tr-support', details: { reason: 'source-changed', sourceState } } };
}

function shown(stored: StoredInvestigation, isNew = false): Investigation {
  return {
    id: stored.id,
    sourceId: stored.sourceId,
    title: stored.title,
    caseRef: stored.caseRef,
    status: stored.status,
    startingEntity: { entityType: stored.entityType, stableId: stored.stableId },
    sourceState: sourceStateOf(stored, isNew),
    createdAt: stored.createdAt,
    lastEditedAt: stored.lastEditedAt,
    version: stored.version,
  };
}

/** Saved when the draft names a view and still holds what that view holds. */
function saveOf(stored: StoredInvestigation): { state: 'saved'; savedAt: string } | { state: 'unsaved'; savedAt: null } {
  const view = stored.views.find((entry) => entry.id === stored.basedOnViewId && entry.deleted !== true);
  const draft = draftOf(stored) as { layout: unknown; queryContext: unknown };
  const same = view !== undefined && JSON.stringify([view.layout, view.queryContext, view.notes]) === JSON.stringify([draft.layout, draft.queryContext, stored.draftNotes]);
  return same ? { state: 'saved', savedAt: view.createdAt } : { state: 'unsaved', savedAt: null };
}

function draftOf(stored: StoredInvestigation): unknown {
  if (stored.draftLayout !== undefined && stored.draftQueryContext !== undefined) return { version: stored.draftVersion, layout: stored.draftLayout, queryContext: stored.draftQueryContext, notes: stored.draftNotes, basedOnViewId: stored.basedOnViewId };
  return {
    version: stored.draftVersion,
    notes: stored.draftNotes,
    basedOnViewId: stored.basedOnViewId,
    layout: { schemaVersion: 1, layout: 'force', nodes: [{ t: stored.entityType, id: stored.stableId, pinned: false, hidden: false, groupId: null }], edges: [], groups: [] },
    queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: stored.entityType, id: stored.stableId }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  };
}

/** What the list shows for the entities and relationships of an investigation: the loaded items of its draft. */
function countsOf(stored: StoredInvestigation): { nodeCount: number; edgeCount: number } {
  const layout = (draftOf(stored) as { layout?: { nodes?: unknown[]; edges?: unknown[] } }).layout;
  return { nodeCount: layout?.nodes?.length ?? 0, edgeCount: layout?.edges?.length ?? 0 };
}

/** The synthetic stand-in for the entity and investigation endpoints: it holds the investigations opened since it started, and an entity named `missing` does not exist. */
function createInvestigations(options: SupportServerOptions) {
  const held = new Map<string, StoredInvestigation>();
  const exports = new Map<string, { readonly format: 'json' | 'csv'; readonly filename: string }>();
  let exportMode: 'ok' | 'refused' | 'source-changed' | 'failed' | 'large' = 'ok';
  /** The investigation as the routes that are not restore see it: a deleted one is not there. */
  const live = (id: string): StoredInvestigation | undefined => {
    const stored = held.get(id);
    return stored?.deleted === undefined ? stored : undefined;
  };
  const liveViews = (stored: StoredInvestigation): StoredView[] => stored.views.filter((view) => view.deleted !== true);
  let namedViews: { readonly count: number; readonly lastEditedAt: string | null } = { count: 0, lastEditedAt: null };
  const typesOf = new Map(profilesOf(options).map((profile) => [profile.sourceId, new Set((profile.entityTypes ?? []).map((entry) => entry.type))]));
  const refused = new Set(options.refusedSources ?? []);
  const readable = (sourceId: string): boolean => typesOf.has(sourceId) && !refused.has(sourceId);
  const exists = (sourceId: string, entityType: string, stableId: string): boolean => typesOf.get(sourceId)?.has(entityType) === true && stableId !== 'missing';
  return {
    entity(sourceId: string, entityType: string, stableId: string, response: ServerResponse): void {
      if (!readable(sourceId) || !exists(sourceId, entityType, stableId)) return json(response, 404, NOT_FOUND);
      json(response, 200, node(sourceId, entityType, stableId));
    },
    read(id: string, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      json(response, 200, { investigation: shown(stored), draft: draftOf(stored), save: saveOf(stored) });
    },
    /** Replaces the draft when the version in If-Match is the draft's, as the API does; an unmapped entity type or a missing field is refused. */
    saveDraft(id: string, ifMatch: string | undefined, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : undefined;
      const notes = given?.['notes'];
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (given === undefined || given['layout'] === undefined || given['queryContext'] === undefined || (notes !== null && typeof notes !== 'string') || ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      if (Number(ifMatch.slice(1, -1)) !== stored.draftVersion) return json(response, 409, { error: { code: 'CONFLICTED_VIEW_VERSION', message: 'This view was changed elsewhere. Reload to continue.', retryable: false, traceId: 'tr-support' } });
      const same = JSON.stringify([stored.draftLayout, stored.draftQueryContext, stored.draftNotes]) === JSON.stringify([given['layout'], given['queryContext'], notes]);
      if (same) return json(response, 200, { version: stored.draftVersion, save: saveOf(stored), notes });
      stored.draftVersion += 1;
      stored.draftLayout = given['layout'];
      stored.draftQueryContext = given['queryContext'];
      stored.draftNotes = notes;
      stored.lastEditedAt = new Date().toISOString();
      json(response, 200, { version: stored.draftVersion, save: saveOf(stored), notes });
    },
    /** Saves the draft as a named view, as the API does: the draft's version in If-Match, a closed investigation refused. */
    saveView(id: string, ifMatch: string | undefined, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      const parsed = saveViewRequestSchema.safeParse(body);
      if (!parsed.success || ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (Number(ifMatch.slice(1, -1)) !== stored.draftVersion) return json(response, 409, { error: { code: 'CONFLICTED_VIEW_VERSION', message: 'This view was changed elsewhere. Reload to continue.', retryable: false, traceId: 'tr-support' } });
      const { name, notes, title, expectedInvestigationVersion } = parsed.data;
      if (title !== undefined && expectedInvestigationVersion !== stored.version) return json(response, 409, PLAIN_CONFLICT);
      if (title !== undefined && title !== stored.title) {
        stored.title = title;
        stored.version += 1;
      }
      const draft = draftOf(stored) as { layout: unknown; queryContext: unknown };
      stored.draftNotes = notes;
      const view: StoredView = { id: randomUUID(), name, notes, createdAt: new Date().toISOString(), version: 1, layout: draft.layout, queryContext: draft.queryContext };
      stored.views.push(view);
      stored.basedOnViewId = view.id;
      stored.draftVersion += 1;
      stored.lastEditedAt = view.createdAt;
      json(response, 201, { view: viewShown(view), draft: { version: stored.draftVersion, notes, basedOnViewId: view.id }, save: saveOf(stored), ...(title === undefined ? {} : { investigation: { title: stored.title, version: stored.version } }) });
    },
    listViews(id: string, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      json(response, 200, { items: [...liveViews(stored)].reverse().map(viewShown), nextCursor: null, count: { value: liveViews(stored).length, quality: 'exact', scope: 'named-views' }, draft: { basedOnViewId: stored.basedOnViewId, updatedAt: stored.lastEditedAt } });
    },
    renameView(id: string, viewId: string, ifMatch: string | undefined, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      const view = stored === undefined ? undefined : liveViews(stored).find((entry) => entry.id === viewId);
      if (stored === undefined || view === undefined) return json(response, 404, NOT_FOUND);
      const parsed = renameViewRequestSchema.safeParse(body);
      if (!parsed.success || ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (Number(ifMatch.slice(1, -1)) !== view.version) return json(response, 409, { error: { code: 'CONFLICTED_VIEW_VERSION', message: 'This view was changed elsewhere. Reload to continue.', retryable: false, traceId: 'tr-support' } });
      view.name = parsed.data.name;
      view.version += 1;
      json(response, 200, viewShown(view), { etag: `"${view.version}"` });
    },
    restoreView(id: string, viewId: string, ifMatch: string | undefined, response: ServerResponse): void {
      const stored = live(id);
      const view = stored === undefined ? undefined : liveViews(stored).find((entry) => entry.id === viewId);
      if (stored === undefined || view === undefined) return json(response, 404, NOT_FOUND);
      if (ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (Number(ifMatch.slice(1, -1)) !== stored.draftVersion) return json(response, 409, { error: { code: 'CONFLICTED_VIEW_VERSION', message: 'This view was changed elsewhere. Reload to continue.', retryable: false, traceId: 'tr-support' } });
      stored.draftLayout = view.layout;
      stored.draftQueryContext = view.queryContext;
      stored.draftNotes = view.notes;
      stored.basedOnViewId = view.id;
      stored.draftVersion += 1;
      stored.lastEditedAt = new Date().toISOString();
      json(response, 200, { draft: draftOf(stored), save: saveOf(stored) });
    },
    /** Deletes the investigation whatever its status, restorable for the retention days; the version in If-Match guards it. */
    deleteInvestigation(id: string, ifMatch: string | undefined, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      if (ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      if (Number(ifMatch.slice(1, -1)) !== stored.version) return json(response, 409, PLAIN_CONFLICT);
      const at = new Date();
      stored.deleted = { at: at.toISOString(), purgeAfter: new Date(at.getTime() + RETENTION_DAYS * 86_400_000).toISOString() };
      stored.version += 1;
      json(response, 200, { id: stored.id, version: stored.version, deletedAt: stored.deleted.at, purgeAfter: stored.deleted.purgeAfter }, { etag: `"${stored.version}"` });
    },
    /** Restores a deleted investigation that has not reached its purge date, as it was. */
    restoreInvestigation(id: string, body: unknown, response: ServerResponse): void {
      const stored = held.get(id);
      const parsed = restoreInvestigationRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      if (stored?.deleted === undefined || stored.deleted.purgeAfter <= new Date().toISOString()) return json(response, 404, NOT_FOUND);
      if (parsed.data.expectedVersion !== stored.version) return json(response, 409, PLAIN_CONFLICT);
      stored.deleted = undefined;
      stored.version += 1;
      json(response, 200, { investigation: shown(stored), draft: draftOf(stored), save: saveOf(stored) }, { etag: `"${stored.version}"` });
    },
    /** Deletes a named view with its note: the view is left out of every read and cannot be restored. */
    deleteView(id: string, viewId: string, ifMatch: string | undefined, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      const view = stored === undefined ? undefined : liveViews(stored).find((entry) => entry.id === viewId);
      if (stored === undefined || view === undefined) return json(response, 404, NOT_FOUND);
      const parsed = deleteViewRequestSchema.safeParse(body ?? {});
      if (!parsed.success || ifMatch === undefined || !/^"[1-9][0-9]*"$/.test(ifMatch)) return json(response, 400, INVALID);
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (Number(ifMatch.slice(1, -1)) !== view.version) return json(response, 409, { error: { code: 'CONFLICTED_VIEW_VERSION', message: 'This view was changed elsewhere. Reload to continue.', retryable: false, traceId: 'support' } });
      view.deleted = true;
      view.deletedNote = parsed.data.note === undefined || parsed.data.note === '' ? null : parsed.data.note;
      view.version += 1;
      const basedOn = liveViews(stored).find((entry) => entry.id === stored.basedOnViewId);
      json(response, 200, { id: view.id, version: view.version, deletedAt: new Date().toISOString(), draft: { version: stored.draftVersion, basedOnViewId: basedOn?.id ?? null }, save: saveOf(stored), count: { value: liveViews(stored).length, quality: 'exact', scope: 'named-views' } }, { etag: `"${view.version}"` });
    },
    /** Closes, archives or reopens, with the transitions of the API; a request for the status it has changes nothing. */
    changeStatus(id: string, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      const parsed = statusChangeRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      const { status, expectedVersion } = parsed.data;
      const answer = (): void => json(response, 200, { investigation: { ...shown(stored), closedAt: stored.status === 'closed' ? stored.lastEditedAt : null, archivedAt: stored.status === 'archived' ? stored.lastEditedAt : null } }, { etag: `"${stored.version}"` });
      if (status === stored.status) return answer();
      if (expectedVersion !== stored.version) return json(response, 409, PLAIN_CONFLICT);
      if (status === 'closed' && stored.status === 'archived') return json(response, 409, { error: { code: 'CONFLICT', message: 'An archived investigation must be reopened before it can be closed.', retryable: false, traceId: 'tr-support', details: { reason: 'status-change-not-allowed' } } });
      stored.status = status;
      stored.version += 1;
      answer();
    },
    rename(id: string, body: unknown, response: ServerResponse): void {
      const stored = live(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      const parsed = renameRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      {
        const refusal = writeRefusal(stored);
        if (refusal !== undefined) return json(response, 409, refusal);
      }
      if (parsed.data.expectedVersion !== stored.version) return json(response, 409, PLAIN_CONFLICT);
      if (parsed.data.title !== stored.title) {
        stored.title = parsed.data.title;
        stored.version += 1;
      }
      json(response, 200, { investigation: shown(stored) }, { etag: `"${stored.version}"` });
    },
    /** How the stand-in answers an export: normally, refused as if access changed or as if the source of the export changed, failed, or as if the view were too large. */
    setExportMode(body: unknown, response: ServerResponse): void {
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : {};
      const mode = given['mode'];
      if (mode !== 'ok' && mode !== 'refused' && mode !== 'source-changed' && mode !== 'failed' && mode !== 'large') return json(response, 400, INVALID);
      exportMode = mode;
      json(response, 200, {});
    },
    createExport(id: string, key: string | undefined, body: unknown, response: ServerResponse): void {
      const parsed = exportRequestSchema.safeParse(body);
      if (!parsed.success || key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) return json(response, 400, INVALID);
      const found = live(id);
      if (found === undefined) return json(response, 404, NOT_FOUND);
      const changed = sourceStateOf(found, false);
      if (changed !== 'available') return json(response, 409, { error: { code: 'CONFLICT', message: 'This source now points to a different database or is no longer configured. This investigation is read-only.', retryable: false, traceId: 'tr-support', details: { reason: 'source-changed', sourceState: changed } } });
      if (exportMode === 'large') return json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'This view holds more than one export can. Hide some items, then export again.', retryable: false, traceId: 'support', details: { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'aggregates' } } });
      if (exportMode === 'failed') return json(response, 500, { error: { code: 'EXPORT_FAILED', message: 'The export could not be created.', retryable: true, traceId: 'support' } });
      const exportId = randomUUID();
      const filename = parsed.data.format === 'json' ? 'neburyx-export-20261110T101500Z.json' : 'neburyx-export-20261110T101500Z.zip';
      exports.set(exportId, { format: parsed.data.format, filename });
      json(response, 201, { id: exportId, status: 'ready', format: parsed.data.format, filename, sizeBytes: 2, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-17T10:15:00.000Z' });
    },
    downloadExport(id: string, response: ServerResponse): void {
      const stored = exports.get(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      if (exportMode === 'refused') return json(response, 403, { error: { code: 'ACCESS_DENIED', message: 'Your access changed since this export was made. Export again to get a file that matches your current access.', retryable: false, traceId: 'support', details: { reason: 'access-changed' } } });
      if (exportMode === 'source-changed') return json(response, 403, { error: { code: 'ACCESS_DENIED', message: 'The source of this export changed since it was made. The file is no longer available.', retryable: false, traceId: 'support', details: { reason: 'export-source-changed' } } });
      response.writeHead(200, { 'content-type': stored.format === 'json' ? 'application/json' : 'application/zip', 'content-disposition': `attachment; filename="${stored.filename}"`, 'cache-control': 'no-store' });
      response.end('{}');
    },
    /** Changes the status behind the page's back, as another tab would. */
    setStatus(body: unknown, response: ServerResponse): void {
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : {};
      const stored = typeof given['id'] === 'string' ? held.get(given['id']) : undefined;
      const status = given['status'];
      if (stored === undefined || (status !== 'open' && status !== 'closed' && status !== 'archived')) return json(response, 400, INVALID);
      stored.status = status;
      stored.version += 1;
      json(response, 200, {});
    },
    /** Reads again the entities a draft names: the ones the stand-in holds, and the rest as missing. */
    readRefs(body: unknown, response: ServerResponse): void {
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : undefined;
      const sourceId = given?.['sourceId'];
      const entities = Array.isArray(given?.['entities']) ? given['entities'] : [];
      if (typeof sourceId !== 'string' || !readable(sourceId)) return json(response, 404, NOT_FOUND);
      const refs = entities.flatMap((entry: unknown) => {
        const ref = typeof entry === 'object' && entry !== null ? Object.fromEntries(Object.entries(entry)) : {};
        return typeof ref['entityType'] === 'string' && typeof ref['stableId'] === 'string' ? [{ entityType: ref['entityType'], stableId: ref['stableId'] }] : [];
      });
      const found = refs.filter((ref) => exists(sourceId, ref.entityType, ref.stableId));
      json(response, 200, { nodes: found.map((ref) => node(sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: refs.filter((ref) => !found.includes(ref)).map((ref) => ({ sourceId, ...ref })), edges: [] } });
    },
    /** The named views the list counts: none until a spec sets them, because nothing in the app saves one. */
    holdNamedViews(body: unknown, response: ServerResponse): void {
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : undefined;
      const keys = Object.keys(given ?? {}).sort();
      const parsed = investigationListCountsSchema.shape.savedViews.safeParse({ count: { value: given?.['count'], quality: 'exact', scope: 'named-views' }, lastEditedAt: given?.['lastEditedAt'] });
      if (given === undefined || keys.join() !== 'count,lastEditedAt' || !parsed.success || (parsed.data.count.value === 0) !== (parsed.data.lastEditedAt === null)) return json(response, 400, INVALID);
      namedViews = { count: parsed.data.count.value, lastEditedAt: parsed.data.lastEditedAt };
      json(response, 200, {});
    },
    forgetNamedViews(): void {
      namedViews = { count: 0, lastEditedAt: null };
    },
    forgetInvestigations(): void {
      held.clear();
    },
    list(search: URLSearchParams, response: ServerResponse): void {
      const entries = [...search.entries()];
      const query = investigationListQuerySchema.safeParse(Object.fromEntries(entries));
      if (!query.success || new Set(entries.map(([name]) => name)).size !== entries.length) return json(response, 400, INVALID);
      const limit = query.data.limit ?? DEFAULT_INVESTIGATION_LIST_LIMIT;
      if (limit < 1) return json(response, 400, INVALID);
      if (limit > MAX_INVESTIGATION_LIST_LIMIT) return json(response, 422, { error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: MAX_INVESTIGATION_LIST_LIMIT } } });
      const deleted = query.data.deleted === 'true';
      if (deleted && query.data.status !== undefined) return json(response, 400, INVALID);
      const status = query.data.status ?? 'open';
      const fragment = query.data.q?.toLowerCase();
      const library = [...held.values()].filter((stored) => readable(stored.sourceId) && stored.status === 'open' && stored.deleted === undefined);
      const filterKey = JSON.stringify([deleted ? 'deleted' : status, query.data.source ?? null, fragment ?? null]);
      const now = new Date().toISOString();
      const matching = [...held.values()]
        .filter((stored) => readable(stored.sourceId) && (deleted ? stored.deleted !== undefined && stored.deleted.purgeAfter > now : stored.deleted === undefined && stored.status === status) && (query.data.source === undefined || stored.sourceId === query.data.source) && (fragment === undefined || stored.title.toLowerCase().includes(fragment) || (stored.caseRef?.toLowerCase().includes(fragment) ?? false)))
        .sort((left, right) => (left.createdAt === right.createdAt ? (left.id < right.id ? 1 : -1) : left.createdAt < right.createdAt ? 1 : -1));
      let start = 0;
      if (query.data.cursor !== undefined) {
        const [key, offset] = Buffer.from(query.data.cursor, 'base64url').toString('utf8').split('|');
        if (key !== filterKey || !/^\d+$/.test(offset ?? '')) return json(response, 409, { error: { code: 'CURSOR_INVALIDATED' } });
        start = Number(offset);
      }
      const end = start + limit;
      json(response, 200, {
        retention: { deletedInvestigationsDays: RETENTION_DAYS },
        items: matching.slice(start, end).map((stored) => ({ ...shown(stored), sourceAlias: stored.sourceId, save: saveOf(stored), ...countsOf(stored), ...(stored.deleted === undefined ? {} : { deletedAt: stored.deleted.at, purgeAfter: stored.deleted.purgeAfter }) })),
        nextCursor: end < matching.length ? Buffer.from(`${filterKey}|${end}`).toString('base64url') : null,
        matching: { value: matching.length, quality: 'exact', scope: 'investigations-matching' },
        counts: {
          investigations: { value: library.length, quality: 'exact', scope: 'investigations' },
          sources: { value: new Set(library.map((stored) => stored.sourceId)).size, quality: 'exact', scope: 'investigation-sources' },
          savedViews: { count: { value: Math.max(namedViews.count, [...held.values()].filter((stored) => readable(stored.sourceId)).reduce((total, stored) => total + (stored.deleted === undefined ? liveViews(stored).length : 0), 0)), quality: 'exact', scope: 'named-views' }, lastEditedAt: namedViews.lastEditedAt },
        },
      });
    },
    /** The named views of every investigation held, newest first, a page at a time. */
    ownedViews(search: URLSearchParams, response: ServerResponse): void {
      const entries = [...search.entries()];
      const query = viewListQuerySchema.safeParse(Object.fromEntries(entries));
      if (!query.success || new Set(entries.map(([name]) => name)).size !== entries.length) return json(response, 400, INVALID);
      const limit = query.data.limit ?? DEFAULT_VIEW_PAGE;
      if (limit < 1) return json(response, 400, INVALID);
      if (limit > MAX_VIEW_PAGE) return json(response, 422, { error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: MAX_VIEW_PAGE } } });
      const all = [...held.values()]
        .filter((stored) => readable(stored.sourceId) && stored.deleted === undefined)
        .flatMap((stored) => liveViews(stored).map((view) => ({ stored, view })))
        .sort((left, right) => (left.view.createdAt === right.view.createdAt ? (left.view.id < right.view.id ? 1 : -1) : left.view.createdAt < right.view.createdAt ? 1 : -1));
      let start = 0;
      if (query.data.cursor !== undefined) {
        const offset = Buffer.from(query.data.cursor, 'base64url').toString('utf8');
        if (!/^\d+$/.test(offset)) return json(response, 409, { error: { code: 'CURSOR_INVALIDATED' } });
        start = Number(offset);
      }
      const end = start + limit;
      json(response, 200, {
        items: all.slice(start, end).map(({ stored, view }) => ({ id: view.id, name: view.name, investigation: { id: stored.id, title: stored.title, sourceId: stored.sourceId, sourceAlias: stored.sourceId, status: stored.status }, savedBy: { name: 'Support analyst' }, createdAt: view.createdAt, version: view.version })),
        nextCursor: end < all.length ? Buffer.from(String(end)).toString('base64url') : null,
        count: { value: all.length, quality: 'exact', scope: 'named-views' },
      });
    },
    /** Makes `count` open investigations of a source with titles "Case n" and case references "REF-2026-nnnn", edited a minute apart, and gives some of them a named view. */
    seed(body: unknown, response: ServerResponse): void {
      const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : undefined;
      const count = given?.['count'];
      const sourceId = given?.['sourceId'];
      const viewEvery = typeof given?.['viewEvery'] === 'number' ? given['viewEvery'] : 0;
      const longRow = given?.['longRow'] === true;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 500 || typeof sourceId !== 'string' || !readable(sourceId)) return json(response, 400, INVALID);
      const [entityType] = [...(typesOf.get(sourceId) ?? [])];
      if (entityType === undefined) return json(response, 400, INVALID);
      const base = Date.UTC(2026, 10, 5, 12);
      for (let index = 1; index <= count; index += 1) {
        const at = new Date(base - index * 60_000).toISOString();
        const long = longRow && index === 1;
        const stableId = long ? `LONG-${'0123456789'.repeat(8)}` : `${index}`.padStart(4, '0');
        const stored: StoredInvestigation = { id: randomUUID(), sourceId, title: long ? `Long case ${'title words '.repeat(16)}`.slice(0, 200) : `Case ${index}`, status: 'open', version: 1, caseRef: long ? `REF-LONG-${'9876543210'.repeat(9)}` : `REF-2026-${stableId}`, entityType, stableId, createdAt: at, lastEditedAt: at, draftVersion: 1, draftNotes: null, basedOnViewId: null, views: [] };
        if (viewEvery > 0 && index % viewEvery === 0) {
          const { layout, queryContext } = draftOf(stored) as { layout: unknown; queryContext: unknown };
          stored.views.push({ id: randomUUID(), name: long ? `Saved state ${'with a very long name '.repeat(5)}`.slice(0, 120) : `Saved state ${index}`, notes: null, layout, queryContext, createdAt: at, version: 1 });
        }
        held.set(stored.id, stored);
      }
      json(response, 200, {});
    },
    open(body: unknown, response: ServerResponse): void {
      const parsed = openInvestigationRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      const { entity, caseRef = null } = parsed.data;
      // the synthetic source keys no entity type, so a value and a reference are the same text
      const { entityType } = entity;
      const stableId = 'stableId' in entity ? entity.stableId : entity.value;
      const { sourceId } = parsed.data;
      if (!readable(sourceId)) return json(response, 404, NOT_FOUND);
      if (entity.sourceId !== sourceId) return json(response, 400, MISMATCH);
      if (typesOf.get(sourceId)?.has(entityType) !== true) return json(response, 400, INVALID);
      if (!exists(sourceId, entityType, stableId)) return json(response, 404, NOT_FOUND);
      const existing = caseRef === null ? undefined : [...held.values()].find((stored) => stored.sourceId === sourceId && stored.caseRef === caseRef && stored.entityType === entityType && stored.stableId === stableId);
      if (existing !== undefined) return json(response, 200, { investigation: shown(existing), created: false, draft: { version: existing.draftVersion, notes: existing.draftNotes, basedOnViewId: existing.basedOnViewId }, ...(isRepointed(existing.caseRef) ? {} : { entity: node(sourceId, entityType, stableId) }) });
      const createdAt = new Date().toISOString();
      const stored: StoredInvestigation = { id: randomUUID(), sourceId, title: `${entityType} ${stableId}`, status: 'open', version: 1, caseRef, entityType, stableId, createdAt, lastEditedAt: createdAt, draftVersion: 1, draftNotes: null, basedOnViewId: null, views: [] };
      held.set(stored.id, stored);
      json(response, 201, { investigation: shown(stored, true), created: true, draft: { version: 1, notes: null, basedOnViewId: null }, entity: node(sourceId, entityType, stableId) });
    },
  };
}

const SEARCH_TYPE = 'account';
const MANY = /^many-(\d+)$/;
const MIX = /^mix-(\d+)-(\d+)$/;
const GHOST = /^ghost-(\d+)$/;
const OTHER_TYPE = 'customer';
const RELATED = /^rel-(\d+)$/;
const EVIDENCE = /^ev-(\d+)$/;
/** A text `agg-N` has one aggregate of N relationships with no stable ID that carry the record; the cursor of its next page holds the text and how many members came before. */
const AGGREGATE = /^agg-(\d+)$/;
const AGGREGATE_CURSOR = /^agg:(agg-\d+):(\d+)$/;
const STALLS_ONCE = 'stall';
const STARTS_WITH_SUFFIXES = ['-1', '-2'];
const INVALIDATED = { error: { code: 'CURSOR_INVALIDATED', message: 'This page of results is no longer valid. Start again.', retryable: false, traceId: 'tr-support' } };
/** The cursor of the next page of the exact group of a text `many-N`: the text and how many hits came before. */
const MANY_CURSOR = /^many:(many-\d+):(\d+)$/;
const TIMEOUT = { error: { code: 'QUERY_TIMEOUT', message: 'The source did not answer in time. Try again or refine your filters.', retryable: true, traceId: 'tr-support', details: { timeoutMs: 5000 } } };
const NO_EVIDENCE = { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] };
const NO_RELATED = { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] };

function aggregateOf(sourceId: string, text: string, from: number, to: number, more: boolean): unknown {
  return {
    aggregate: { type: 'SEEN_WITH', from: { sourceId, entityType: SEARCH_TYPE, stableId: `${text}-a` }, to: { sourceId, entityType: SEARCH_TYPE, stableId: `${text}-b` } },
    members: Array.from({ length: to - from }, (_, index) => ({ records: [{ sourceRecordId: `REC-${text}` }], observedAt: `2026-03-01T10:${String(from + index + 1).padStart(2, '0')}:00Z` })),
    memberCount: { value: to - from, quality: more || from > 0 ? 'lowerBound' : 'exact', scope: 'members' },
    rules: [],
  };
}

function evidenceGroup(sourceId: string, text: string): unknown {
  const aggregate = AGGREGATE.exec(text);
  if (aggregate !== null) {
    const found = Number(aggregate[1]);
    const shown = Math.min(found, SEARCH_GROUP_CAP);
    const more = found > SEARCH_GROUP_CAP;
    return { hits: [aggregateOf(sourceId, text, 0, shown, more)], count: { value: shown, quality: more ? 'lowerBound' : 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [], ...(more ? { nextCursor: `agg:${text}:${shown}` } : {}) };
  }
  if (text.startsWith('evold')) {
    const supports = { sourceId, type: 'LINKS', from: SEARCH_TYPE, to: SEARCH_TYPE, stableId: `legacy-${text}` };
    return { hits: [{ supports, records: [{ sourceRecordId: `REC-${text}` }], rules: [] }], count: { value: 1, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] };
  }
  if (text.startsWith('evx')) {
    const supports = { sourceId, type: 'LINKS', from: SEARCH_TYPE, to: SEARCH_TYPE, stableId: `${text}-l01` };
    return { hits: [{ supports, records: [{ sourceRecordId: `REC-${text}` }, { property: 'docId', unreadable: true }], rules: [] }], count: { value: 1, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] };
  }
  const matches = EVIDENCE.exec(text);
  if (matches !== null) {
    const found = Number(matches[1]);
    const shown = Math.min(found, SEARCH_GROUP_CAP);
    const hits = Array.from({ length: shown }, (_, index) => ({
      supports: { sourceId, type: 'LINKS', from: SEARCH_TYPE, to: SEARCH_TYPE, stableId: `${text}-l${String(index + 1).padStart(2, '0')}` },
      records: [{ sourceRecordId: `REC-${text}-${index + 1}` }],
      rules: index === 0 ? [{ ruleId: 'shared-link', ruleVersion: 1 }] : [],
    }));
    return { hits, count: { value: shown, quality: found > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] };
  }
  if (text.startsWith('evfail')) return { ...NO_EVIDENCE, searchable: true, count: { quality: 'unknown', scope: 'search:evidence' } };
  if (text.startsWith('evdrop')) return { ...NO_EVIDENCE, disabledRelationshipTypes: [{ relationshipType: 'LINKS', from: SEARCH_TYPE, to: SEARCH_TYPE, property: 'recordId', reason: 'index-unavailable' }] };
  return NO_EVIDENCE;
}

function relatedGroup(sourceId: string, text: string): unknown {
  const matches = RELATED.exec(text);
  if (matches !== null) {
    const found = Number(matches[1]);
    const shown = Math.min(found, SEARCH_GROUP_CAP);
    const hits = Array.from({ length: shown }, (_, index) => ({ node: node(sourceId, SEARCH_TYPE, `${text}-r${String(index + 1).padStart(2, '0')}`), matchedProperties: ['batchRef'] }));
    return { hits, count: { value: shown, quality: found > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] };
  }
  if (text.startsWith('relfail') || text.startsWith('exactfail')) return { ...NO_RELATED, searchable: true, count: { quality: 'unknown', scope: 'search:related' } };
  if (text.startsWith('reldrop')) return { ...NO_RELATED, disabledTypes: [{ entityType: SEARCH_TYPE, property: 'batchRef', reason: 'index-building', typeSearched: false }] };
  return NO_RELATED;
}

/**
 * The synthetic stand-in for the search: a text `many-N` has N matches (25 at most are shown, and more than 25 is a lower bound), a text `rel-N` has one exact match and N related records
 * (shown and counted the same way), `relfail` has its related read fail while the exact group answers, `exactfail` the reverse (with two related records), `reldrop` has its related type left out,
 * a text that starts with `stall` times out the first time that text is searched and answers the next time, a text that starts with `missing` matches nothing, and any other text matches one
 * entity of that ID and has no related group; a type-ahead search also answers two entities whose ID starts with that text. For the Filters: every answer that is not a type-ahead answer counts the match
 * set (an entry for each of an account and a customer, the three match modes and the total, from the groups of the text), a text `mix-A-B` has A account and B customer exact matches, a text `ghost-N` counts N
 * matches and shows none, a text that starts with `facfail` has its facet read fail while one exact match answers, and the selection (`entityTypes`, `matchModes`) narrows the rows and hides the groups.
 * The exact group of `many-N` with more than 25 matches has a cursor, and `POST /v1/search/entities/more` answers its next pages of 25, each counting the hits of every page so far, the last with an exact count; so does the evidence group of `agg-N`
 * (one aggregate of N relationships with no stable ID); a text that starts with `evx` has one supporting relationship with a value that cannot be shown; any other cursor is CURSOR_INVALIDATED.
 */
function createSearch(options: SupportServerOptions) {
  const stalled = new Set<string>();
  const sourceId = options.profile.sourceId;
  return {
    run(body: unknown, response: ServerResponse): void {
      const parsed = searchRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      if (parsed.data.sourceId !== sourceId) return json(response, 404, NOT_FOUND);
      const { text } = parsed.data;
      if (text.startsWith(STALLS_ONCE) && !stalled.has(text)) {
        stalled.add(text);
        return json(response, 504, TIMEOUT);
      }
      const matches = MANY.exec(text);
      const found = matches === null ? (text.startsWith('missing') ? 0 : 1) : Number(matches[1]);
      const shown = Math.min(found, SEARCH_GROUP_CAP);
      const ids = matches === null ? [text] : Array.from({ length: shown }, (_, index) => `${text}-${String(index + 1).padStart(2, '0')}`);
      const withRelated = parsed.data.typeahead !== true;
      const exactFailed = withRelated && text.startsWith('exactfail');
      const mixed = MIX.exec(text);
      const ghost = GHOST.exec(text);
      const accounts = mixed === null ? 0 : Number(mixed[1]);
      const customers = mixed === null ? 0 : Number(mixed[2]);
      const none: readonly string[] = [];
      const selected = parsed.data.typeahead === true ? { entityTypes: none, matchModes: none } : { entityTypes: parsed.data.entityTypes ?? none, matchModes: parsed.data.matchModes ?? none };
      const knownTypes = [SEARCH_TYPE, OTHER_TYPE];
      if (selected.entityTypes.some((type) => !knownTypes.includes(type))) return json(response, 400, INVALID);
      const typeOn = (type: string): boolean => selected.entityTypes.length === 0 || selected.entityTypes.includes(type);
      const modeOn = (mode: string): boolean => selected.matchModes.length === 0 || selected.matchModes.includes(mode);
      const exactOf = (type: string, count: number, prefix: string) => Array.from({ length: Math.min(count, SEARCH_GROUP_CAP) }, (_, index) => ({ type, node: node(sourceId, type, `${prefix}-${String(index + 1).padStart(2, '0')}`) }));
      const mixedNodes = [...exactOf(SEARCH_TYPE, accounts, `${text}-a`), ...exactOf(OTHER_TYPE, customers, `${text}-c`)].slice(0, SEARCH_GROUP_CAP);
      const plain = ghost !== null ? [] : mixed !== null ? mixedNodes : exactFailed ? [] : ids.slice(0, found === 0 ? 0 : shown).map((id) => ({ type: SEARCH_TYPE, node: node(sourceId, SEARCH_TYPE, id) }));
      const nodes = !modeOn('exact') ? [] : plain.filter((entry) => typeOn(entry.type)).map((entry) => entry.node);
      const startsWith = parsed.data.typeahead === true && matches === null && found > 0 ? STARTS_WITH_SUFFIXES.map((suffix) => node(sourceId, SEARCH_TYPE, `${text}${suffix}`)) : [];
      const related = !withRelated
        ? { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] }
        : exactFailed
        ? { hits: ['x1', 'x2'].map((id) => ({ node: node(sourceId, SEARCH_TYPE, `${text}-${id}`), matchedProperties: ['batchRef'] })), count: { value: 2, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] }
        : relatedGroup(sourceId, text);
      const relatedShown = !modeOn('related') ? { ...NO_RELATED } : typeOn(SEARCH_TYPE) ? related : { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] };
      const failures = !withRelated ? [] : exactFailed ? [{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : text.startsWith('relfail') ? [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : [];
      const exactCount = exactFailed ? { quality: 'unknown', scope: 'search:exact' } : { value: nodes.length, quality: (mixed !== null ? accounts + customers : found) > SEARCH_GROUP_CAP && modeOn('exact') ? 'lowerBound' : 'exact', scope: 'search:exact' };
      const relatedFound = RELATED.exec(text);
      const evidenceFound = EVIDENCE.exec(text);
      const counted = (found: number, scope: string) => ({ value: Math.min(found, SEARCH_GROUP_CAP), quality: found > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact', scope });
      const exactAll = ghost !== null ? Number(ghost[1]) : mixed !== null ? accounts + customers : exactFailed ? 0 : found;
      const accountsAll = ghost !== null ? Number(ghost[1]) : mixed !== null ? accounts : exactFailed ? 0 : found;
      const relatedAll = relatedFound === null ? 0 : Number(relatedFound[1]);
      const aggregateFound = AGGREGATE.exec(text);
      const evidenceAll = evidenceFound !== null ? Number(evidenceFound[1]) : aggregateFound !== null ? Number(aggregateFound[1]) : 0;
      const facets = text.startsWith('facfail')
        ? { searchable: true, total: { quality: 'unknown', scope: 'search:facet:total' }, entityType: [], matchMode: [] }
        : {
            searchable: true,
            total: counted(exactAll + relatedAll, 'search:facet:total'),
            entityType: [
              { entityType: SEARCH_TYPE, count: counted(accountsAll + relatedAll, 'search:facet:entityType') },
              { entityType: OTHER_TYPE, count: counted(customers, 'search:facet:entityType') },
            ],
            matchMode: [
              { mode: 'exact', count: counted(exactAll, 'search:facet:matchMode') },
              { mode: 'related', count: counted(relatedAll, 'search:facet:matchMode') },
              { mode: 'evidence', count: counted(evidenceAll, 'search:facet:matchMode') },
            ],
          };
      const shownEvidence = !modeOn('evidence') ? NO_EVIDENCE : withRelated ? evidenceGroup(sourceId, text) : NO_EVIDENCE;
      const paged = matches !== null && found > SEARCH_GROUP_CAP && modeOn('exact') && parsed.data.typeahead !== true;
      const answer = searchResultSchema.parse({
        sourceId,
        exact: nodes,
        exactMatches: nodes.map((entity) => ({ ref: nodeSchema.parse(entity).ref, matchedProperties: ['code'] })),
        cap: SEARCH_GROUP_CAP,
        searchable: modeOn('exact'),
        counts: { exact: modeOn('exact') ? exactCount : { value: 0, quality: 'exact', scope: 'search:exact' } },
        ...(paged ? { exactNextCursor: `many:${text}:${SEARCH_GROUP_CAP}` } : {}),
        disabledTypes: [],
        related: relatedShown,
        evidence: shownEvidence,
        failures: [...(withRelated && text.startsWith('evfail') ? [{ group: 'evidence', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : []), ...failures, ...(text.startsWith('facfail') && parsed.data.typeahead !== true ? [{ group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : [])],
        dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
        warnings: [],
        elapsedMs: 180,
        ...(parsed.data.typeahead === true ? {} : { facets, filters: { entityTypes: knownTypes.filter((type) => selected.entityTypes.includes(type)), matchModes: ['exact', 'related', 'evidence'].filter((mode) => selected.matchModes.includes(mode)) } }),
        ...(parsed.data.typeahead === true ? { startsWith: { nodes: startsWith, count: { value: startsWith.length, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] } } : {}),
      });
      json(response, 200, answer);
    },
    more(body: unknown, response: ServerResponse): void {
      const parsed = searchMoreRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      if (parsed.data.sourceId !== sourceId) return json(response, 404, NOT_FOUND);
      const members = AGGREGATE_CURSOR.exec(parsed.data.cursor);
      const aggregateTotal = AGGREGATE.exec(parsed.data.text);
      if (parsed.data.group === 'evidence' && members !== null && aggregateTotal !== null && members[1] === parsed.data.text) {
        const from = Number(members[2]);
        const found = Number(aggregateTotal[1]);
        const to = Math.min(from + SEARCH_GROUP_CAP, found);
        const more = to < found;
        const page = searchMoreResultSchema.parse({
          sourceId,
          group: 'evidence',
          hits: [aggregateOf(sourceId, parsed.data.text, from, to, more)],
          count: { value: to, quality: more ? 'lowerBound' : 'exact', scope: 'search:evidence' },
          ...(more ? { nextCursor: `agg:${parsed.data.text}:${to}` } : {}),
          dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
          warnings: [],
        });
        return json(response, 200, page);
      }
      const cursor = MANY_CURSOR.exec(parsed.data.cursor);
      const total = MANY.exec(parsed.data.text);
      if (parsed.data.group !== 'exact' || cursor === null || total === null || cursor[1] !== parsed.data.text) return json(response, 409, INVALIDATED);
      const from = Number(cursor[2]);
      const found = Number(total[1]);
      const to = Math.min(from + SEARCH_GROUP_CAP, found);
      const more = to < found;
      const pageNodes = Array.from({ length: to - from }, (_, index) => node(sourceId, SEARCH_TYPE, `${parsed.data.text}-${String(from + index + 1).padStart(2, '0')}`));
      const page = searchMoreResultSchema.parse({
        sourceId,
        group: 'exact',
        nodes: pageNodes,
        matches: pageNodes.map((entity) => ({ ref: nodeSchema.parse(entity).ref, matchedProperties: ['code'] })),
        count: { value: to, quality: more ? 'lowerBound' : 'exact', scope: 'search:exact' },
        ...(more ? { nextCursor: `many:${parsed.data.text}:${to}` } : {}),
        dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
        warnings: [],
      });
      json(response, 200, page);
    },
  };
}

function api(path: string, options: SupportServerOptions, response: ServerResponse): void {
  const profiles = profilesOf(options);
  if (path === '/healthz' || path === '/readyz') return json(response, 200, { status: 'ok' });
  if (path === '/v1/me') return json(response, 200, me(profiles.map((profile) => profile.sourceId)));
  const profile = profiles.find((candidate) => path === `/v1/sources/${encodeURIComponent(candidate.sourceId)}/profile`);
  if (profile !== undefined) return json(response, 200, profile);
  json(response, 404, { error: { code: 'NOT_FOUND' } });
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function file(root: string, path: string): Promise<{ readonly body: Buffer; readonly type: string } | undefined> {
  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  const found = await stat(target).catch(() => undefined);
  if (found === undefined || !found.isFile()) return undefined;
  return { body: await readFile(target), type: TYPES[extname(target)] ?? 'application/octet-stream' };
}

/** Answers the few API reads the pages make with synthetic bodies and serves a built web app, with the app's navigation fallback for a path that is not a file. */
export function createSupportServer(options: SupportServerOptions): Server {
  const root = normalize(options.root);
  const investigations = createInvestigations(options);
  const search = createSearch(options);
  const sources = createSources(options);
  const patterns = createPatterns(() => profilesOf(options));
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || PROBE_PATHS.has(path);
      if (request.method === 'POST' && path === '/v1/investigations') return investigations.open(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/graph/read-refs') return investigations.readRefs(await bodyOf(request), response);
      const exporting = /^\/v1\/investigations\/([^/]+)\/exports$/.exec(path);
      if (request.method === 'POST' && exporting?.[1] !== undefined) return investigations.createExport(decodeURIComponent(exporting[1]), typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined, await bodyOf(request), response);
      const downloading = /^\/v1\/exports\/([^/]+)\/download$/.exec(path);
      if (request.method === 'GET' && downloading?.[1] !== undefined) return investigations.downloadExport(decodeURIComponent(downloading[1]), response);
      if (request.method === 'POST' && path === '/__support/export-mode') return investigations.setExportMode(await bodyOf(request), response);
      const lifecycle = /^\/v1\/investigations\/([^/]+)\/status$/.exec(path);
      if (request.method === 'POST' && lifecycle?.[1] !== undefined) return investigations.changeStatus(decodeURIComponent(lifecycle[1]), await bodyOf(request), response);
      const renaming = /^\/v1\/investigations\/([^/]+)$/.exec(path);
      if (request.method === 'DELETE' && renaming?.[1] !== undefined) return investigations.deleteInvestigation(decodeURIComponent(renaming[1]), request.headers['if-match'], response);
      const restoringInvestigation = /^\/v1\/investigations\/([^/]+)\/restore$/.exec(path);
      if (request.method === 'POST' && restoringInvestigation?.[1] !== undefined) return investigations.restoreInvestigation(decodeURIComponent(restoringInvestigation[1]), await bodyOf(request), response);
      if (request.method === 'PUT' && renaming?.[1] !== undefined) return investigations.rename(decodeURIComponent(renaming[1]), await bodyOf(request), response);
      if (request.method === 'POST' && path === '/__support/set-status') return investigations.setStatus(await bodyOf(request), response);
      const saving = /^\/v1\/investigations\/([^/]+)\/draft$/.exec(path);
      if (request.method === 'PUT' && saving?.[1] !== undefined) return investigations.saveDraft(decodeURIComponent(saving[1]), request.headers['if-match'], await bodyOf(request), response);
      const viewing = /^\/v1\/investigations\/([^/]+)\/views(?:\/([^/]+)(\/restore|\/delete)?)?$/.exec(path);
      if (viewing?.[1] !== undefined) {
        const [, investigationId, viewId, action] = viewing;
        const restoring = action === '/restore' ? action : undefined;
        const id = decodeURIComponent(investigationId ?? '');
        if (request.method === 'POST' && viewId === undefined) return investigations.saveView(id, request.headers['if-match'], await bodyOf(request), response);
        if (request.method === 'GET' && viewId === undefined) return investigations.listViews(id, response);
        if (request.method === 'PUT' && viewId !== undefined && restoring === undefined) return investigations.renameView(id, decodeURIComponent(viewId), request.headers['if-match'], await bodyOf(request), response);
        if (request.method === 'POST' && viewId !== undefined && restoring !== undefined) return investigations.restoreView(id, decodeURIComponent(viewId), request.headers['if-match'], response);
        if (request.method === 'POST' && viewId !== undefined && action === '/delete') return investigations.deleteView(id, decodeURIComponent(viewId), request.headers['if-match'], await bodyOf(request), response);
      }
      if (request.method === 'GET' && path === '/v1/templates') return patterns.list(new URL(request.url ?? '/', 'http://localhost').searchParams.get('sourceId'), response);
      const running = /^\/v1\/templates\/([^/]+)\/run$/.exec(path);
      if (request.method === 'POST' && running?.[1] !== undefined) return patterns.run(decodeURIComponent(running[1]), await bodyOf(request), response, request);
      if (request.method === 'POST' && path === '/v1/patterns/validate') return patterns.validate(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/__support/patterns-mode') return patterns.setMode(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/search/entities') return search.run(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/search/entities/more') return search.more(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/__support/seed-investigations') return investigations.seed(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/__support/named-views') return investigations.holdNamedViews(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/__support/forget-investigations') {
        investigations.forgetInvestigations();
        return json(response, 200, {});
      }
      if (request.method === 'POST' && path.startsWith('/__support/')) {
        if (path === '/__support/reset') investigations.forgetNamedViews();
        return sources.control(path, await bodyOf(request), response);
      }
      const testing = /^\/v1\/sources\/([^/]+)\/test$/.exec(path);
      if (request.method === 'POST' && testing?.[1] !== undefined) return sources.test(decodeURIComponent(testing[1]), response);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      if (isApi) {
        const parts = path.split('/').map((part) => decodeURIComponent(part));
        const [, , kind, first, second, third] = parts;
        if (kind === 'entities' && parts.length === 6 && first !== undefined && second !== undefined && third !== undefined) {
          const entityType = valueOfPathSegment(second);
          const stableId = valueOfPathSegment(third);
          return entityType === undefined || stableId === undefined ? json(response, 400, INVALID) : investigations.entity(first, entityType, stableId, response);
        }
        if (kind === 'edges' && parts.length === 4 && first !== undefined) return edge(parseEdgeRefSegment(first), response);
        if (kind === 'views' && parts.length === 3) return investigations.ownedViews(new URL(request.url ?? '/', 'http://localhost').searchParams, response);
        if (kind === 'investigations' && parts.length === 3) return investigations.list(new URL(request.url ?? '/', 'http://localhost').searchParams, response);
        if (kind === 'investigations' && parts.length === 4 && first !== undefined) return investigations.read(first, response);
        if (kind === 'sources' && parts.length === 3) return sources.list(response);
        return api(path, options, response);
      }
      const found = (await file(root, path)) ?? (await file(root, 'index.html'));
      if (found === undefined) return json(response, 404, { error: { code: 'NOT_FOUND' } });
      response.writeHead(200, { 'content-type': found.type });
      response.end(found.body);
    })().catch(() => json(response, 500, { error: { code: 'SERVER_ERROR' } }));
  });
}
