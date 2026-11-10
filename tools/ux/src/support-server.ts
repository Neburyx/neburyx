import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { DEFAULT_INVESTIGATION_LIST_LIMIT, parseEdgeRefSegment, investigationListCountsSchema, nodeSchema, investigationListQuerySchema, type Investigation, type LastTest, openInvestigationRequestSchema, SEARCH_GROUP_CAP, searchMoreRequestSchema, searchMoreResultSchema, searchRequestSchema, searchResultSchema, type SourceSummary, sourceSummaryFieldsSchema, sourceSummarySchema, type SourceTestReport, type EdgeReadRef, valueOfPathSegment } from '@neburyx/contracts';

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

const SOURCE_SUMMARY = { state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 4, relationshipTypes: 6, derivedRules: 2 }, demoCase: null } as const;

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
      const stored = held.get(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      json(response, 200, { investigation: shown(stored), draft: draftOf(stored) });
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
      const eligible = [...held.values()]
        .filter((stored) => readable(stored.sourceId))
        .sort((left, right) => (left.createdAt === right.createdAt ? (left.id < right.id ? 1 : -1) : left.createdAt < right.createdAt ? 1 : -1));
      json(response, 200, {
        items: eligible.slice(0, limit).map((stored) => ({ ...shown(stored), sourceAlias: stored.sourceId, save: { state: 'unsaved', savedAt: null } })),
        hasMore: eligible.length > limit,
        counts: {
          investigations: { value: eligible.length, quality: 'exact', scope: 'investigations' },
          sources: { value: new Set(eligible.map((stored) => stored.sourceId)).size, quality: 'exact', scope: 'investigation-sources' },
          savedViews: { count: { value: namedViews.count, quality: 'exact', scope: 'named-views' }, lastEditedAt: namedViews.lastEditedAt },
        },
      });
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
      if (existing !== undefined) return json(response, 200, { investigation: shown(existing), created: false, ...(isRepointed(existing.caseRef) ? {} : { entity: node(sourceId, entityType, stableId) }) });
      const stored: StoredInvestigation = { id: randomUUID(), sourceId, title: `${entityType} ${stableId}`, caseRef, entityType, stableId, createdAt: new Date().toISOString() };
      held.set(stored.id, stored);
      json(response, 201, { investigation: shown(stored, true), created: true, entity: node(sourceId, entityType, stableId) });
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
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || PROBE_PATHS.has(path);
      if (request.method === 'POST' && path === '/v1/investigations') return investigations.open(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/search/entities') return search.run(await bodyOf(request), response);
      if (request.method === 'POST' && path === '/v1/search/entities/more') return search.more(await bodyOf(request), response);
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
