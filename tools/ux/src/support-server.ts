import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { DEFAULT_INVESTIGATION_LIST_LIMIT, investigationListQuerySchema, type Investigation, type LastTest, openInvestigationRequestSchema, SEARCH_GROUP_CAP, searchRequestSchema, searchResultSchema, type SourceSummary, sourceSummarySchema, type SourceTestReport, valueOfPathSegment } from '@neburyx/contracts';

interface SupportProfile {
  readonly sourceId: string;
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

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
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

const SOURCE_SUMMARY = { state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 4, relationshipTypes: 6, derivedRules: 2 } } as const;

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
        const parsed = sourceSummarySchema.omit({ id: true }).partial().safeParse(change);
        if (!known.includes(sourceId) || !parsed.success) return json(response, 400, INVALID);
        next.set(sourceId, parsed.data);
      }
      changes = next;
      json(response, 200, {});
    },
  };
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-support' } };
const MISMATCH = { error: { code: 'SOURCE_MISMATCH', message: 'The request mixes more than one source.', retryable: false, traceId: 'tr-support' } };
const INVALID = { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } };

interface StoredInvestigation {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly caseRef: string | null;
  readonly entityType: string;
  readonly stableId: string;
  readonly createdAt: string;
}

function node(sourceId: string, entityType: string, stableId: string): unknown {
  return {
    ref: { sourceId, entityType, stableId },
    display: { title: `${entityType} ${stableId}`, type: entityType },
    properties: [],
    qualityFlags: [],
    provenanceRefs: [],
    authorization: { canInspect: true, canExport: true },
  };
}

/** An investigation opened with a case reference that starts with this is new when it is opened, and once it exists reads back, and is resumed, as one whose source now points at another database. */
const REPOINTED_CASE_REF = 'repointed';
const isRepointed = (caseRef: string | null): boolean => caseRef?.startsWith(REPOINTED_CASE_REF) === true;

function shown(stored: StoredInvestigation, isNew = false): Investigation {
  return {
    id: stored.id,
    sourceId: stored.sourceId,
    title: stored.title,
    caseRef: stored.caseRef,
    status: 'open',
    startingEntity: { entityType: stored.entityType, stableId: stored.stableId },
    sourceState: !isNew && isRepointed(stored.caseRef) ? 'repointed' : 'available',
    createdAt: stored.createdAt,
    lastEditedAt: stored.createdAt,
    version: 1,
  };
}

function draftOf(stored: StoredInvestigation): unknown {
  return {
    version: 1,
    layout: { schemaVersion: 1, layout: 'force', nodes: [{ t: stored.entityType, id: stored.stableId, pinned: false, hidden: false, groupId: null }], edges: [], groups: [] },
    queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: stored.entityType, id: stored.stableId }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  };
}

/** The synthetic stand-in for the entity and investigation endpoints: it holds the investigations opened since it started, and an entity named `missing` does not exist. */
function createInvestigations(options: SupportServerOptions) {
  const held = new Map<string, StoredInvestigation>();
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
      const stored = held.get(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      json(response, 200, { investigation: shown(stored), draft: draftOf(stored) });
    },
    list(search: URLSearchParams, response: ServerResponse): void {
      const entries = [...search.entries()];
      const query = investigationListQuerySchema.safeParse(Object.fromEntries(entries));
      if (!query.success || new Set(entries.map(([name]) => name)).size !== entries.length) return json(response, 400, INVALID);
      const limit = query.data.limit ?? DEFAULT_INVESTIGATION_LIST_LIMIT;
      const eligible = [...held.values()]
        .filter((stored) => readable(stored.sourceId))
        .sort((left, right) => (left.createdAt === right.createdAt ? (left.id < right.id ? 1 : -1) : left.createdAt < right.createdAt ? 1 : -1));
      json(response, 200, {
        items: eligible.slice(0, limit).map((stored) => ({ ...shown(stored), sourceAlias: stored.sourceId, save: { state: 'unsaved', savedAt: null } })),
        hasMore: eligible.length > limit,
      });
    },
    open(body: unknown, response: ServerResponse): void {
      const parsed = openInvestigationRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      const { entity, caseRef = null } = parsed.data;
      const { entityType, stableId } = entity;
      const { sourceId } = parsed.data;
      if (!readable(sourceId)) return json(response, 404, NOT_FOUND);
      if (entity.sourceId !== sourceId) return json(response, 400, MISMATCH);
      if (typesOf.get(sourceId)?.has(entityType) !== true) return json(response, 400, INVALID);
      if (!exists(sourceId, entityType, stableId)) return json(response, 404, NOT_FOUND);
      const existing = caseRef === null ? undefined : [...held.values()].find((stored) => stored.sourceId === sourceId && stored.caseRef === caseRef && stored.entityType === entityType && stored.stableId === stableId);
      if (existing !== undefined) return json(response, 200, { investigation: shown(existing), created: false, ...(isRepointed(existing.caseRef) ? {} : { entity: node(sourceId, entityType, stableId) }) });
      const stored: StoredInvestigation = { id: randomUUID(), sourceId, title: `${entityType} ${stableId}`, caseRef, entityType, stableId, createdAt: new Date().toISOString() };
      held.set(stored.id, stored);
      json(response, 201, { investigation: shown(stored, true), created: true, entity: node(sourceId, entityType, stableId) });
    },
  };
}

const SEARCH_TYPE = 'account';
const MANY = /^many-(\d+)$/;
const RELATED = /^rel-(\d+)$/;
const STALLS_ONCE = 'stall';
const STARTS_WITH_SUFFIXES = ['-1', '-2'];
const TIMEOUT = { error: { code: 'QUERY_TIMEOUT', message: 'The source did not answer in time. Try again or refine your filters.', retryable: true, traceId: 'tr-support', details: { timeoutMs: 5000 } } };
const NO_RELATED = { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] };

function relatedGroup(sourceId: string, text: string): unknown {
  const matches = RELATED.exec(text);
  if (matches !== null) {
    const found = Number(matches[1]);
    const shown = Math.min(found, SEARCH_GROUP_CAP);
    const hits = Array.from({ length: shown }, (_, index) => ({ node: node(sourceId, SEARCH_TYPE, `${text}-r${String(index + 1).padStart(2, '0')}`), matchedProperties: ['batchRef'] }));
    return { hits, count: { value: shown, quality: found > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] };
  }
  if (text.startsWith('relfail') || text.startsWith('exactfail')) return { ...NO_RELATED, searchable: true, count: { quality: 'unknown', scope: 'search:related' } };
  if (text.startsWith('reldrop')) return { ...NO_RELATED, disabledTypes: [{ entityType: SEARCH_TYPE, reason: 'index-unavailable' }] };
  return NO_RELATED;
}

/**
 * The synthetic stand-in for the search: a text `many-N` has N matches (25 at most are shown, and more than 25 is a lower bound), a text `rel-N` has one exact match and N related records
 * (shown and counted the same way), `relfail` has its related read fail while the exact group answers, `exactfail` the reverse (with two related records), `reldrop` has its related type left out,
 * a text that starts with `stall` times out the first time that text is searched and answers the next time, a text that starts with `missing` matches nothing, and any other text matches one
 * entity of that ID and has no related group; a type-ahead search also answers two entities whose ID starts with that text.
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
      const nodes = exactFailed ? [] : ids.slice(0, found === 0 ? 0 : shown).map((id) => node(sourceId, SEARCH_TYPE, id));
      const startsWith = parsed.data.typeahead === true && matches === null && found > 0 ? STARTS_WITH_SUFFIXES.map((suffix) => node(sourceId, SEARCH_TYPE, `${text}${suffix}`)) : [];
      const related = !withRelated
        ? { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] }
        : exactFailed
        ? { hits: ['x1', 'x2'].map((id) => ({ node: node(sourceId, SEARCH_TYPE, `${text}-${id}`), matchedProperties: ['batchRef'] })), count: { value: 2, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] }
        : relatedGroup(sourceId, text);
      const failures = !withRelated ? [] : exactFailed ? [{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : text.startsWith('relfail') ? [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] : [];
      const answer = searchResultSchema.parse({
        sourceId,
        exact: nodes,
        cap: SEARCH_GROUP_CAP,
        searchable: true,
        counts: { exact: exactFailed ? { quality: 'unknown', scope: 'search:exact' } : { value: nodes.length, quality: found > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact', scope: 'search:exact' } },
        disabledTypes: [],
        related,
        failures,
        dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
        warnings: [],
        elapsedMs: 180,
        ...(parsed.data.typeahead === true ? { startsWith: { nodes: startsWith, count: { value: startsWith.length, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] } } : {}),
      });
      json(response, 200, answer);
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
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || PROBE_PATHS.has(path);
      if (request.method === 'POST' && path === '/v1/investigations') return investigations.open(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/search/entities') return search.run(await bodyOf(request), response);
      if (request.method === 'POST' && path.startsWith('/__support/')) return sources.control(path, await bodyOf(request), response);
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
