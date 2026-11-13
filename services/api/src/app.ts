import { randomBytes, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import fastifyStatic from '@fastify/static';
import { type ErrorCode, type ProfileExtension, deleteInvestigationResponseSchema, deleteViewRequestSchema, deleteViewResponseSchema, restoreInvestigationRequestSchema, MAX_DRAFT_DOCUMENT_BYTES, readRefsRequestSchema, readRefsResponseSchema, exportRequestSchema, exportSchema, draftWriteRequestSchema, draftWriteResponseSchema, renameRequestSchema, renameResponseSchema, statusChangeRequestSchema, statusChangeResponseSchema, derivedNeighborsRequestSchema, derivedNeighborsResponseSchema, templateListQuerySchema, patternPreviewRequestSchema, patternRunRequestSchema, patternRunResponseSchema, patternPreviewResponseSchema, patternValidateRequestSchema, patternValidateResponseSchema, savePatternRequestSchema, savedPatternSchema, patternListQuerySchema, patternListResponseSchema, changePatternRequestSchema, deletePatternResponseSchema, templateListResponseSchema, templateRunRequestSchema, templateRunResponseSchema, coverageRequestSchema, coverageResponseSchema, degreePreviewRequestSchema, edgeDetailSchema, edgePathSchema, entityLookupRequestSchema, degreePreviewSchema, entityPathSchema, entityQuerySchema, expandRequestSchema, expandResponseSchema, healthResponseSchema, investigationListQuerySchema, investigationListResponseSchema, investigationResponseSchema, meResponseSchema, nodeSchema, parseEdgeRefSegment, parseSourceLinkSegment, sourceLinkPathSchema, sourceLinkQuerySchema, openInvestigationRequestSchema, openInvestigationResponseSchema, readyResponseSchema, searchMoreRequestSchema, searchMoreResultSchema, searchRequestSchema, searchResultSchema, sourceProfileSchema, sourceTestReportSchema, sourcesResponseSchema, renameViewRequestSchema, restoreViewResponseSchema, saveViewRequestSchema, saveViewResponseSchema, viewListQuerySchema, viewListResponseSchema, ownedViewListResponseSchema, namedViewSchema } from '@neburyx/contracts';
import { z } from 'zod';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { setMaxListeners } from 'node:events';
import { AppError, RequestCancelled, codeForFailure, detailsOf, errorResponse, errorStatus } from './errors.js';
import type { AppStore } from './app-store.js';
import { deriveReferenceKeys, type ReferenceKeys } from './reference/keys.js';
import { canonicalLookup, canonicalOpen } from './reference/resolve.js';
import { createCoverageService } from './graph/coverage-service.js';
import { createReadRefsService } from './graph/read-refs-service.js';
import { createExportService } from './exports/export-service.js';
import { fingerprintOf, IDEMPOTENT_REPLAY_HEADER, idempotencyKeyOf, runOnce } from './exports/idempotency.js';
import { createShownReader } from './exports/shown-reader.js';
import type { ExportFileStore } from './exports/store.js';
import { createDegreePreviewService } from './graph/degree-preview-service.js';
import { createDerivedNeighborsService } from './graph/derived-neighbors-service.js';
import { createTemplateListService } from './graph/template-list-service.js';
import { createPatternPreviewService } from './patterns/preview-service.js';
import { createPatternRunService } from './patterns/run-service.js';
import { createPatternValidateService } from './patterns/validate-service.js';
import { createSavedPatternService } from './patterns/saved-pattern-service.js';
import { createTemplateRunService } from './graph/template-run-service.js';
import type { TemplateProbe } from './graph/template-probes.js';
import { createExpandService } from './graph/expand-service.js';
import { createDegreeCache, type DegreeCacheOptions } from './graph/degree-cache.js';
import { NO_DEGREE_VERDICTS, type DegreeVerdicts } from './source-test/usability.js';
import { createEdgeReader } from './edges/edge-reader.js';
import { createEntityReader } from './entities/entity-reader.js';
import { asksForJsonOnly, REFUSAL_PAGE_CSP, refusalPage } from './source-links/refusal-page.js';
import { createSourceLinkService } from './source-links/source-link-service.js';
import { createSearchService } from './search/search-service.js';
import { createInvestigationService } from './investigations/investigation-service.js';
import { createCursorCodec, type CursorCodec } from './gate/cursor/codec.js';
import { createViewService } from './investigations/view-service.js';
import { createOwnedViewService } from './investigations/owned-view-service.js';
import { createStoredReferences } from './investigations/stored-references.js';
import { createSourceAccess } from './investigations/source-access.js';
import { createRequestLimiter, type RequestLimiter } from './rate/request-limiter.js';
import { defaultCatalog } from './gate/default-catalog.js';
import type { Gate, IndexReader, TemplateCatalog } from './gate/types.js';
import type { JobRunner } from './jobs/runner.js';
import type { MappingModel } from './mapping/model.js';
import { buildSourceProfile } from './registry/profile.js';
import { matchesEntityTag } from './registry/etag.js';
import { identityHashOf } from './registry/identity-hash.js';
import { summariesOf } from './registry/summary.js';
import { readinessResponse } from './health/readiness.js';
import { communitySeams } from './seams/community-seams.js';
import { mountExtensionRoutes } from './profile/mount.js';
import type { Seams } from './seams/seams.js';
import type { RegisteredRoute } from './permissions.js';
import { allUnknown, type ReachabilityView } from './source-ping/cache.js';
import type { SourceTester } from './source-test/tester.js';

export interface AppOptions {
  readonly webRoot: string;
  readonly logger: FastifyBaseLogger;
  readonly store: AppStore;
  readonly jobs?: JobRunner | undefined;
  readonly seams?: Seams | undefined;
  /** Whether the preview switch is on, which the routes of an extension are told; absent, they are told it is off. */
  readonly previewOn?: boolean | undefined;
  readonly mapping?: MappingModel | undefined;
  readonly sourceTester?: SourceTester | undefined;
  readonly gate?: Gate | undefined;
  readonly indexes?: IndexReader | undefined;
  /** The keys of the reference tokens of keyed entity types; the source summary carries a demo case's keyed starting entity as a token. */
  readonly referenceKeys?: ReferenceKeys | undefined;
  /** Signs and checks the cursors of the lists of the application database; absent, a key made for this copy alone. */
  readonly cursors?: CursorCodec | undefined;
  /** What the checks showed about how the source answers a count of neighbors; absent, every degree preview is bounded. */
  readonly degreeVerdicts?: DegreeVerdicts | undefined;
  /** Overrides the lifetime and size of the degree preview cache, which is only kept when the verdicts are given. */
  readonly degreeCache?: DegreeCacheOptions | undefined;
  readonly reachability?: ReachabilityView | undefined;
  readonly stopPing?: (() => void) | undefined;
  readonly drainPing?: (() => Promise<void>) | undefined;
  readonly closeSources?: (() => Promise<void>) | undefined;
  /** The request rate of this copy; a test passes one with its own clock. */
  readonly limiter?: RequestLimiter;
  /** Where export files are kept; without it the export routes are not registered. */
  readonly exportFiles?: ExportFileStore | undefined;
  /** The version of the policy a person's access is under, for an export to be made under and a download to be checked against; Community has none. */
  readonly policyVersion?: ((sourceId: string) => string) | undefined;
  /** The catalog the gate validates against, which the template list describes; absent, the shipped one. */
  readonly catalog?: TemplateCatalog | undefined;
  /** The time a window of a template run counts back from; a test passes a fixed one. */
  readonly templateRunClock?: (() => Date) | undefined;
  /** The heavy-operation probes of the pattern templates (tests inject a map without one to reach an `unknown` estimate). */
  readonly templateProbes?: ReadonlyMap<string, TemplateProbe> | undefined;
  /** The enterprise extension, only when the preview switch is on; its routes are mounted and `GET /v1/me` says `enterprise`. */
  readonly extension?: ProfileExtension | undefined;
}

const API_PREFIX = '/v1';
/** The audit action of a denied test of a source through the route. */
const SOURCE_TEST_AUDIT_ACTION = 'source.test';
/** The router answers a path parameter longer than its limit as an unknown route (404). No limit here leaves the length of a stable ID to its schema, which answers INVALID_REQUEST, and the length of the whole request line to the HTTP parser. */
const NO_PATH_PARAMETER_LIMIT = Number.MAX_SAFE_INTEGER;
const noQuerySchema = z.strictObject({});
const profileParamsSchema = z.strictObject({ id: z.string() });

/** A version in `If-Match` is the quoted integer the `ETag` of the same resource carried. */
const ifMatchSchema = z.string().regex(/^"[1-9][0-9]{0,9}"$/).transform((tag) => Number(tag.slice(1, -1)));

/** The draft is two documents of at most `MAX_DRAFT_DOCUMENT_BYTES` each, so a body may hold twice that and its envelope. */
const DRAFT_BODY_LIMIT = 2 * MAX_DRAFT_DOCUMENT_BYTES + 4096;
/** An export names the items it holds by reference, in a body of at most one megabyte. */
const EXPORT_BODY_LIMIT = 1_048_576;
const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);
const TRACE_HEADER = 'x-trace-id';
const UNMATCHED_ROUTE = 'unmatched';
const UNHANDLED_ERROR_KIND = 'unhandled_error';

function newTraceId(): string {
  return `tr-${randomUUID()}`;
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

function sendApiError(reply: FastifyReply, request: FastifyRequest, code: ErrorCode, details?: unknown): FastifyReply {
  const body = errorResponse(code, request.id, details);
  const waitMs = code === 'RATE_LIMITED' || code === 'SOURCE_UNAVAILABLE' ? body.error.details?.retryAfterMs : undefined;
  if (waitMs !== undefined) reply.header('retry-after', String(Math.ceil(waitMs / 1000)));
  return reply
    .header(TRACE_HEADER, request.id)
    .code(errorStatus(code))
    .send(body);
}

const apiRoutes = new WeakMap<FastifyInstance, { readonly method: string; readonly url: string }[]>();

export function apiRoutesOf(app: FastifyInstance): readonly { readonly method: string; readonly url: string }[] {
  return apiRoutes.get(app) ?? [];
}

const appSeams = new WeakMap<FastifyInstance, Seams>();
const registeredRoutes = new WeakMap<FastifyInstance, RegisteredRoute[]>();

/** Every route the application registered, whatever its path, with the permission it declared; the web build's file routes are left out. */
export function registeredRoutesOf(app: FastifyInstance): readonly RegisteredRoute[] {
  return registeredRoutes.get(app) ?? [];
}

export function seamsOf(app: FastifyInstance): Seams {
  const seams = appSeams.get(app);
  if (!seams) throw new Error('seamsOf was given an app that buildApp did not build');
  return seams;
}

const SIGNAL_LISTENERS = 32;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const completed = new WeakSet<FastifyRequest>();
  const cancels = new WeakMap<FastifyRequest, AbortController>();
  /** Aborted when the client closes the connection before the answer is written; the request stream's own close also fires once the body is read, so it is the response's close that counts. */
  const controllerOf = (request: FastifyRequest): AbortController => {
    const found = cancels.get(request);
    if (found !== undefined) return found;
    const held = new AbortController();
    // one request has a handful of reads at once (a search makes up to seven), each with a listener in the slot queue and one in the adapter, removed when it ends: the default of ten is below that
    setMaxListeners(SIGNAL_LISTENERS, held.signal);
    cancels.set(request, held);
    return held;
  };
  const signalOf = (request: FastifyRequest): AbortSignal => controllerOf(request).signal;
  const unmatched = new WeakSet<FastifyRequest>();
  const waiting = new WeakSet<Socket>();
  const inFlight = new WeakMap<Socket, { readonly request: FastifyRequest; readonly reply: FastifyReply }[]>();

  function logCompleted(request: FastifyRequest, reply: FastifyReply, aborted: boolean, statusCode?: number): void {
    if (completed.has(request)) return;
    completed.add(request);
    const queue = inFlight.get(request.raw.socket);
    const position = queue?.findIndex((entry) => entry.request === request) ?? -1;
    if (position >= 0) queue?.splice(position, 1);
    request.log.info(
      {
        event: 'request.completed',
        method: request.method,
        route:
          request.is404 || unmatched.has(request) ? UNMATCHED_ROUTE : (request.routeOptions.url ?? UNMATCHED_ROUTE),
        statusCode: statusCode ?? reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        ...(aborted ? { aborted: true } : {}),
      },
      'request completed',
    );
  }

  function writeParserFailure(socket: Socket, traceId: string, headOnly: boolean): void {
    const body = JSON.stringify(errorResponse('INVALID_REQUEST', traceId));
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nx-trace-id: ${traceId}\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${headOnly ? '' : body}`,
    );
  }

  function answerUnparsedData(socket: Socket): void {
    const traceId = newTraceId();
    options.logger.info(
      { event: 'request.completed', traceId, method: 'unknown', route: UNMATCHED_ROUTE, statusCode: 400, durationMs: 0 },
      'request completed',
    );
    writeParserFailure(socket, traceId, false);
  }

  function answerParserFailure(socket: Socket): void {
    const queue = inFlight.get(socket) ?? [];
    const last = queue.at(-1);
    const owner = last !== undefined && !last.request.raw.complete ? last : undefined;
    const pending = owner === undefined ? queue : queue.slice(0, -1);
    const lastPending = pending.at(-1);
    if (lastPending !== undefined) {
      // Responses go out in the order the requests came in, so the bad data waits for the ones before it.
      if (waiting.has(socket)) return;
      waiting.add(socket);
      lastPending.reply.raw.once('close', () => {
        waiting.delete(socket);
        if (socket.writable) answerParserFailure(socket);
      });
      return;
    }
    if (owner === undefined) return answerUnparsedData(socket);
    if (owner.reply.raw.headersSent) {
      logCompleted(owner.request, owner.reply, true);
      socket.destroy();
      return;
    }
    logCompleted(owner.request, owner.reply, false, 400);
    writeParserFailure(socket, owner.request.id, owner.request.method === 'HEAD');
  }

  const app = Fastify({
    loggerInstance: options.logger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'traceId' }),
    genReqId: newTraceId,
    routerOptions: { maxParamLength: NO_PATH_PARAMETER_LIMIT },
    requestIdHeader: false,
    frameworkErrors: (_error, request, reply) => {
      sendApiError(reply, request, 'INVALID_REQUEST');
      logCompleted(request, reply, false);
    },
    clientErrorHandler: (_error, socket) => {
      if (socket.writable) answerParserFailure(socket);
    },
  });

  let stoppingJobs: Promise<void> | undefined;
  app.addHook('preClose', () => {
    options.stopPing?.();
    stoppingJobs = options.jobs?.stop();
    stoppingJobs?.catch(() => undefined);
  });
  app.addHook('onClose', async () => {
    await stoppingJobs;
    await options.drainPing?.();
    await options.closeSources?.();
    await options.store.close();
  });

  const routes: { readonly method: string; readonly url: string }[] = [];
  apiRoutes.set(app, routes);
  const registered: RegisteredRoute[] = [];
  registeredRoutes.set(app, registered);
  const getRoutesWithHead = new Set<string>();
  // installed before any route exists, so a route added anywhere is seen; only the web build's file routes are skipped
  let registeringWebFiles = false;
  app.addHook('onRoute', (route) => {
    if (registeringWebFiles) return;
    for (const method of [route.method].flat()) registered.push({ method, url: route.url, permission: route.config?.permission });
    if (!route.url.startsWith(API_PREFIX) && !PROBE_PATHS.has(route.url)) return;
    const headIsGenerated = getRoutesWithHead.has(route.url);
    for (const method of [route.method].flat()) {
      if (method === 'GET' && route.exposeHeadRoute !== false) getRoutesWithHead.add(route.url);
      if (!(method === 'HEAD' && headIsGenerated)) routes.push({ method, url: route.url });
    }
  });

  registeringWebFiles = true;
  try {
    await app.register(fastifyStatic, { root: options.webRoot });
  } finally {
    registeringWebFiles = false;
  }

  app.addHook('onRequest', async (request, reply) => {
    inFlight.set(request.raw.socket, [...(inFlight.get(request.raw.socket) ?? []), { request, reply }]);
    reply.header(TRACE_HEADER, request.id);
    reply.raw.once('close', () => {
      const aborted = !reply.raw.writableFinished;
      if (aborted) controllerOf(request).abort();
      logCompleted(request, reply, aborted);
    });
    const servedByApiRoute = request.routeOptions.url?.startsWith(API_PREFIX) ?? false;
    if (isApiPath(request.url) && !servedByApiRoute) {
      unmatched.add(request);
      return sendApiError(reply, request, 'NOT_FOUND');
    }
    return undefined;
  });

  app.addHook('onResponse', async (request, reply) => {
    logCompleted(request, reply, false);
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof RequestCancelled) {
      // the client is gone: there is nobody to answer, and the one log line is the request's completion
      reply.hijack();
      return;
    }
    const code = codeForFailure(error);
    if (code === 'INTERNAL_ERROR') {
      request.log.error({ event: 'request.failed', errorKind: UNHANDLED_ERROR_KIND }, 'request failed');
    }
    return sendApiError(reply, request, code, detailsOf(error));
  });

  app.setNotFoundHandler(async (request, reply) => {
    const servesPage = (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url);
    if (!servesPage) return sendApiError(reply, request, 'NOT_FOUND');
    return reply.sendFile('index.html');
  });

  app.get('/healthz', { config: { permission: 'public' } }, async () => healthResponseSchema.parse({ status: 'ok' }));

  const reachability = options.reachability ?? allUnknown(options.mapping?.sources.length ?? 0);

  app.get('/readyz', { config: { permission: 'public' } }, async (_request, reply) => {
    const { statusCode, body } = readinessResponse(await options.store.readiness(), reachability.counts());
    return reply.code(statusCode).send(readyResponseSchema.parse(body));
  });

  const mapping: MappingModel = options.mapping ?? { sources: [] };
  const limiter = options.limiter ?? createRequestLimiter();
  app.addHook('onClose', async () => limiter.close());
  const access = createSourceAccess({ mapping, seams: options.seams ?? communitySeams(), logger: options.logger, limiter });

  app.get('/v1/me', { exposeHeadRoute: false, config: { permission: 'principal' } }, async () => {
    const [identity, rows] = await Promise.all([options.store.current(), options.store.listSources()]);
    const sources = summariesOf(rows, mapping, undefined, options.referenceKeys).map((source) => ({ sourceId: source.id, viewSensitive: true, synthetic: source.synthetic }));
    return meResponseSchema.parse({ ...identity, edition: options.extension === undefined ? 'community' : 'enterprise', sources });
  });

  if (options.extension !== undefined) mountExtensionRoutes(app, options.extension, options.store, { previewOn: options.previewOn === true, audit: (options.seams ?? communitySeams()).audit });

  app.get('/v1/sources', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
    if (!noQuerySchema.safeParse(request.query).success) throw new AppError('INVALID_REQUEST');
    const rows = await options.store.listSources();
    const checked = mapping.sources.map((source) => ({ id: source.id, identityHash: identityHashOf(source), configHash: source.configHash }));
    const latest = await options.store.latestChecksFor(checked, (sourceId) => options.logger.warn({ event: 'source.check_unreadable', sourceId }, 'a stored check could not be read'));
    return sourcesResponseSchema.parse({ items: summariesOf(rows, mapping, new Map(latest.map((check) => [check.sourceId, check.report])), options.referenceKeys), nextCursor: null });
  });

  app.get('/v1/sources/:id/profile', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request, reply) => {
    if (!noQuerySchema.safeParse(request.query).success) throw new AppError('INVALID_REQUEST');
    const params = profileParamsSchema.safeParse(request.params);
    const source = params.success ? mapping.sources.find((candidate) => candidate.id === params.data.id) : undefined;
    if (source === undefined) throw new AppError('NOT_FOUND');
    const tag = `"${source.configHash}"`;
    reply.header('etag', tag);
    if (matchesEntityTag(request.headers['if-none-match'], tag)) return reply.code(304).send();
    return sourceProfileSchema.parse(buildSourceProfile(source));
  });

  app.post('/v1/sources/:id/test', { config: { permission: 'principal' } }, async (request) => {
    if (!noQuerySchema.safeParse(request.query).success || request.body !== undefined) throw new AppError('INVALID_REQUEST');
    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) throw new AppError('INVALID_REQUEST');
    if (options.sourceTester === undefined) throw new AppError('INTERNAL_ERROR');
    const identity = await options.store.current();
    await access.require({ traceId: request.id, principal: identity.principal, sourceId: params.data.id, auditAction: SOURCE_TEST_AUDIT_ACTION, rate: 'count' });
    const report = await options.sourceTester.run({ traceId: request.id, principal: identity.principal, sourceId: params.data.id });
    return sourceTestReportSchema.parse(report);
  });

  if (options.gate !== undefined) {
    const referenceKeys = options.referenceKeys ?? deriveReferenceKeys(randomBytes(32));
    const entities = createEntityReader({ gate: options.gate, mapping, access });
    app.get('/v1/entities/:sourceId/:entityType/:stableId', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const path = entityPathSchema.safeParse(request.params);
      const query = entityQuerySchema.safeParse(request.query);
      if (!path.success || !query.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const node = await entities.read({ traceId: request.id, principal: identity.principal, ...path.data, mask: query.data.mask === 'true', rate: 'count', signal: signalOf(request) });
      return nodeSchema.parse(node);
    });

    const edges = createEdgeReader({ gate: options.gate, mapping, access });
    app.get('/v1/edges/:ref', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const path = edgePathSchema.safeParse(request.params);
      const query = entityQuerySchema.safeParse(request.query);
      const ref = path.success ? parseEdgeRefSegment(path.data.ref) : undefined;
      if (!path.success || !query.success || ref === undefined) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const detail = await edges.read({ traceId: request.id, principal: identity.principal, ref, mask: query.data.mask === 'true', rate: 'count', signal: signalOf(request) });
      return edgeDetailSchema.parse(detail);
    });

    const sourceLinks = createSourceLinkService({ mapping, access, entities, edges, audit: (options.seams ?? communitySeams()).audit, references: referenceKeys, logger: options.logger });
    app.get('/v1/source-links/:ref', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request, reply) => {
      const path = sourceLinkPathSchema.safeParse(request.params);
      const query = sourceLinkQuerySchema.safeParse(request.query);
      const link = path.success ? parseSourceLinkSegment(path.data.ref) : undefined;
      if (!path.success || !query.success || link === undefined || (link.form === 'entity') === (query.data.record !== undefined)) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      let address: string;
      try {
        address = await sourceLinks.open({ traceId: request.id, principal: identity.principal, link, record: query.data.record, mask: query.data.mask === 'true', headers: request.headers, signal: signalOf(request) });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND' || asksForJsonOnly(request.headers.accept)) throw error;
        return reply.code(404).header('content-type', 'text/html; charset=utf-8').header('content-security-policy', REFUSAL_PAGE_CSP).header('x-content-type-options', 'nosniff').send(refusalPage(request.id));
      }
      return reply.code(302).header('location', address).send();
    });

    app.post('/v1/entities/lookup', { config: { permission: 'principal' } }, async (request) => {
      const body = entityLookupRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const lookup = canonicalLookup(mapping, referenceKeys, body.data);
      const node = await entities.read({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, ...lookup, mask: body.data.mask === true, rate: 'count', signal: signalOf(request) });
      return nodeSchema.parse(node);
    });

    const searching = createSearchService({ gate: options.gate, mapping, access, references: referenceKeys, ...(options.indexes === undefined ? {} : { indexes: options.indexes }) });
    app.post('/v1/search/entities', { config: { permission: 'principal' } }, async (request) => {
      const body = searchRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const narrowing = body.data.typeahead === true ? {} : { ...(body.data.entityTypes === undefined ? {} : { entityTypes: body.data.entityTypes }), ...(body.data.matchModes === undefined ? {} : { matchModes: body.data.matchModes }) };
      const result = await searching.search({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, text: body.data.text, mask: body.data.mask === true, typeahead: body.data.typeahead === true, signal: signalOf(request), ...narrowing });
      return searchResultSchema.parse(result);
    });

    app.post('/v1/search/entities/more', { config: { permission: 'principal' } }, async (request) => {
      const body = searchMoreRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const { sourceId, text, group, cursor, entityTypes, exactRefs } = body.data;
      const page = await searching.more({ traceId: request.id, principal: identity.principal, sourceId, text, group, cursor, mask: body.data.mask === true, signal: signalOf(request), ...(entityTypes === undefined ? {} : { entityTypes }), ...(exactRefs === undefined ? {} : { exactRefs }) });
      return searchMoreResultSchema.parse(page);
    });

    const degreeCache = options.degreeVerdicts === undefined ? undefined : { store: createDegreeCache(options.degreeCache) };
    const auditSink = (options.seams ?? communitySeams()).audit;
    const degrees = createDegreePreviewService({ gate: options.gate, mapping, access, entities, verdicts: options.degreeVerdicts ?? NO_DEGREE_VERDICTS, ...(degreeCache === undefined ? {} : { cache: { ...degreeCache, audit: auditSink, logger: options.logger } }) });
    app.post('/v1/graph/preview-expansion', { config: { permission: 'principal' } }, async (request) => {
      const body = degreePreviewRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const preview = await degrees.preview({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, ...body.data.ref, mask: body.data.mask === true, signal: signalOf(request) });
      return degreePreviewSchema.parse(preview);
    });

    const derivedNeighbors = createDerivedNeighborsService({ gate: options.gate, mapping, access, entities });
    app.post('/v1/graph/derived-neighbors', { config: { permission: 'principal' } }, async (request) => {
      const body = derivedNeighborsRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await derivedNeighbors.derive({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, ...body.data.ref, mask: body.data.mask === true, signal: signalOf(request) });
      return derivedNeighborsResponseSchema.parse(answer);
    });

    const templateList = createTemplateListService({ mapping, catalog: options.catalog ?? defaultCatalog() });
    app.get('/v1/templates', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const query = templateListQuerySchema.safeParse(request.query);
      if (!query.success) throw new AppError('INVALID_REQUEST');
      return templateListResponseSchema.parse(templateList.list(query.data.sourceId));
    });

    const templateRuns = createTemplateRunService({ gate: options.gate, mapping, access, ...(options.templateRunClock === undefined ? {} : { now: options.templateRunClock }), ...(options.templateProbes === undefined ? {} : { probes: options.templateProbes }) });
    const runSeams = options.seams ?? communitySeams();
    const runPolicyVersion = options.policyVersion ?? (() => 'none');
    app.post('/v1/templates/:id/run', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = templateRunRequestSchema.safeParse(request.body);
      const key = idempotencyKeyOf(request.headers['idempotency-key']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || key === undefined) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const principal = identity.principal;
      const sourceId = body.data.sourceId;
      const answer = await runOnce(
        { store: options.store, policy: runSeams.policy, policyVersion: runPolicyVersion },
        { principal, sourceId, key, fingerprint: fingerprintOf({ method: 'POST', path: request.url.split('?')[0] ?? '', query: '', body: request.body }), stillReadable: () => Promise.resolve(mapping.sources.some((source) => source.id === sourceId)) },
        async () => {
          const made = await templateRuns.run({ traceId: request.id, principal, sourceId, id: params.data.id, params: body.data.params, mask: body.data.mask === true, continue: body.data.continue === true, signal: signalOf(request) });
          return { statusCode: 200, body: templateRunResponseSchema.parse(made), replayed: false };
        },
        (error) => (error instanceof AppError && error.code !== 'RATE_LIMITED' ? { statusCode: errorStatus(error.code), body: errorResponse(error.code, request.id, error.details) } : undefined),
      );
      if (answer.replayed) reply.header(IDEMPOTENT_REPLAY_HEADER, 'true');
      return reply.code(answer.statusCode).send(answer.body);
    });

    const patternRuns = createPatternRunService({ gate: options.gate, mapping, access, ...(options.templateRunClock === undefined ? {} : { now: options.templateRunClock }), ...(options.templateProbes === undefined ? {} : { probes: options.templateProbes }) });
    app.post('/v1/patterns/run', { config: { permission: 'principal' } }, async (request, reply) => {
      const body = patternRunRequestSchema.safeParse(request.body);
      const key = idempotencyKeyOf(request.headers['idempotency-key']);
      if (!noQuerySchema.safeParse(request.query).success || !body.success || key === undefined) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const principal = identity.principal;
      const sourceId = body.data.sourceId;
      const answer = await runOnce(
        { store: options.store, policy: runSeams.policy, policyVersion: runPolicyVersion },
        { principal, sourceId, key, fingerprint: fingerprintOf({ method: 'POST', path: request.url.split('?')[0] ?? '', query: '', body: request.body }), stillReadable: () => Promise.resolve(mapping.sources.some((source) => source.id === sourceId)) },
        async () => {
          const made = await patternRuns.run({ traceId: request.id, principal, sourceId, definition: body.data.definition, anchor: body.data.anchor, limit: body.data.limit, mask: body.data.mask === true, continue: body.data.continue === true, signal: signalOf(request) });
          return { statusCode: 200, body: patternRunResponseSchema.parse(made), replayed: false };
        },
        (error) => (error instanceof AppError && error.code !== 'RATE_LIMITED' ? { statusCode: errorStatus(error.code), body: errorResponse(error.code, request.id, error.details) } : undefined),
      );
      if (answer.replayed) reply.header(IDEMPOTENT_REPLAY_HEADER, 'true');
      return reply.code(answer.statusCode).send(answer.body);
    });

    const readRefs = createReadRefsService({ gate: options.gate, mapping, access, audit: auditSink, logger: options.logger });
    app.post('/v1/graph/read-refs', { config: { permission: 'principal' } }, async (request) => {
      const body = readRefsRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await readRefs.read({ traceId: request.id, principal: identity.principal, request: body.data, signal: signalOf(request) });
      return readRefsResponseSchema.parse(answer);
    });

    const coverage = createCoverageService({ mapping, access, verdicts: options.degreeVerdicts ?? NO_DEGREE_VERDICTS, audit: auditSink, logger: options.logger, ...(degreeCache === undefined ? {} : { cache: degreeCache }) });
    app.post('/v1/graph/coverage', { config: { permission: 'principal' } }, async (request) => {
      const body = coverageRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await coverage.coverage({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, mask: body.data.mask === true, entities: body.data.entities });
      return coverageResponseSchema.parse(answer);
    });

    const patternValidate = createPatternValidateService({ mapping, access });
    app.post('/v1/patterns/validate', { config: { permission: 'principal' } }, async (request) => {
      const body = patternValidateRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await patternValidate.validate({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, definition: body.data.definition, mask: body.data.mask === true });
      return patternValidateResponseSchema.parse(answer);
    });

    const patternPreview = createPatternPreviewService({ mapping, access });
    app.post('/v1/patterns/preview', { config: { permission: 'principal' } }, async (request) => {
      const body = patternPreviewRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await patternPreview.preview({ traceId: request.id, principal: identity.principal, sourceId: body.data.sourceId, definition: body.data.definition, mask: body.data.mask === true });
      return patternPreviewResponseSchema.parse(answer);
    });

    const exportFiles = options.exportFiles;
    if (exportFiles !== undefined) {
      const policyVersion = options.policyVersion ?? (() => 'none');
      const seams = options.seams ?? communitySeams();
      const exportService = createExportService({
        store: options.store,
        files: exportFiles,
        reader: createShownReader({ readRefs, coverage }),
        mapping,
        access,
        policy: seams.policy,
        policyVersion,
        audit: auditSink,
        logger: options.logger,
      });
      app.post('/v1/investigations/:id/exports', { bodyLimit: EXPORT_BODY_LIMIT, config: { permission: 'principal' } }, async (request, reply) => {
        const params = profileParamsSchema.safeParse(request.params);
        const body = exportRequestSchema.safeParse(request.body);
        const key = idempotencyKeyOf(request.headers['idempotency-key']);
        if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || key === undefined) throw new AppError('INVALID_REQUEST');
        const identity = await options.store.current();
        const principal = identity.principal;
        const stored = await options.store.readInvestigation(params.data.id, principal.id);
        if (stored === undefined) throw new AppError('NOT_FOUND');
        const answer = await runOnce(
          { store: options.store, policy: seams.policy, policyVersion },
          { principal, sourceId: stored.investigation.sourceId, key, fingerprint: fingerprintOf({ method: 'POST', path: request.url.split('?')[0] ?? '', query: '', body: request.body }), stillReadable: async () => (await options.store.readInvestigation(params.data.id, principal.id)) !== undefined },
          async () => {
            const made = await exportService.create({ traceId: request.id, principal, investigationId: params.data.id, request: body.data, signal: signalOf(request) });
            return { statusCode: 201, body: exportSchema.parse(made), replayed: false };
          },
          (error) => (error instanceof AppError ? { statusCode: errorStatus(error.code), body: errorResponse(error.code, request.id, error.details) } : undefined),
        );
        if (answer.replayed) reply.header(IDEMPOTENT_REPLAY_HEADER, 'true');
        return reply.code(answer.statusCode).send(answer.body);
      });

      app.get('/v1/exports/:id', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
        const params = profileParamsSchema.safeParse(request.params);
        if (!noQuerySchema.safeParse(request.query).success || !params.success) throw new AppError('INVALID_REQUEST');
        const identity = await options.store.current();
        return exportSchema.parse(await exportService.get({ principal: identity.principal, id: params.data.id }));
      });

      app.get('/v1/exports/:id/download', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request, reply) => {
        const params = profileParamsSchema.safeParse(request.params);
        if (!noQuerySchema.safeParse(request.query).success || !params.success) throw new AppError('INVALID_REQUEST');
        const identity = await options.store.current();
        const file = await exportService.download({ traceId: request.id, principal: identity.principal, id: params.data.id });
        return reply
          .header('content-type', file.contentType)
          .header('content-disposition', `attachment; filename="${file.filename}"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .send(file.bytes);
      });
    }

    const expansions = createExpandService({ gate: options.gate, mapping, access, entities, ...(options.templateRunClock === undefined ? {} : { now: options.templateRunClock }) });
    app.post('/v1/graph/expand', { config: { permission: 'principal' } }, async (request) => {
      const body = expandRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const { sourceId, ref, relTypes, neighborTypes, direction, filters, rank, window, limit, cursors, mask } = body.data;
      const answer = await expansions.expand({ traceId: request.id, principal: identity.principal, sourceId, entityType: ref.entityType, stableId: ref.stableId, ...(relTypes === undefined ? {} : { relTypes }), neighborTypes, direction: direction ?? 'both', signal: signalOf(request), ...(filters === undefined ? {} : { filters }), ...(rank === undefined ? {} : { rank }), ...(window === undefined ? {} : { window }), ...(limit === undefined ? {} : { limit }), ...(cursors === undefined ? {} : { cursors }), mask: mask === true });
      return expandResponseSchema.parse(answer);
    });

    const storedReferences = createStoredReferences(mapping, referenceKeys);
    const listCursors = options.cursors ?? createCursorCodec({ key: randomBytes(32), clock: Date.now });
    const investigations = createInvestigationService({ cursors: listCursors, store: options.store, entities, mapping, access, references: storedReferences, audit: auditSink });
    app.post('/v1/investigations', { config: { permission: 'principal' } }, async (request, reply) => {
      const body = openInvestigationRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.open({ traceId: request.id, principal: identity.principal, request: canonicalOpen(mapping, referenceKeys, body.data), signal: signalOf(request) });
      return reply
        .code(answer.created ? 201 : 200)
        .header('etag', `"${answer.body.investigation.version}"`)
        .send(openInvestigationResponseSchema.parse(answer.body));
    });

    app.get('/v1/investigations', { config: { permission: 'principal' } }, async (request) => {
      const query = investigationListQuerySchema.safeParse(request.query);
      if (!query.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const { limit, cursor, status, deleted, source, q } = query.data;
      const answer = await investigations.list({ principal: identity.principal, limit, cursor, status, deleted: deleted === 'true', sourceId: source, text: q });
      return investigationListResponseSchema.parse(answer);
    });

    app.put('/v1/investigations/:id/draft', { bodyLimit: DRAFT_BODY_LIMIT, config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = draftWriteRequestSchema.safeParse(request.body);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || !expected.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.saveDraft({ id: params.data.id, principal: identity.principal, expectedVersion: expected.data, draft: body.data });
      return reply.header('etag', `"${answer.version}"`).send(draftWriteResponseSchema.parse(answer));
    });

    app.put('/v1/investigations/:id', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = renameRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.rename({ id: params.data.id, principal: identity.principal, expectedVersion: body.data.expectedVersion, title: body.data.title });
      return reply.header('etag', `"${answer.investigation.version}"`).send(renameResponseSchema.parse(answer));
    });

    app.post('/v1/investigations/:id/status', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = statusChangeRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.changeStatus({ traceId: request.id, id: params.data.id, principal: identity.principal, expectedVersion: body.data.expectedVersion, status: body.data.status });
      return reply.header('etag', `"${answer.investigation.version}"`).send(statusChangeResponseSchema.parse(answer));
    });

    app.delete('/v1/investigations/:id', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !expected.success || (request.body !== undefined && request.body !== null)) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.delete({ traceId: request.id, id: params.data.id, principal: identity.principal, expectedVersion: expected.data });
      return reply.header('etag', `"${answer.version}"`).send(deleteInvestigationResponseSchema.parse(answer));
    });

    app.post('/v1/investigations/:id/restore', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = restoreInvestigationRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.restore({ traceId: request.id, id: params.data.id, principal: identity.principal, expectedVersion: body.data.expectedVersion });
      return reply.header('etag', `"${answer.investigation.version}"`).send(investigationResponseSchema.parse(answer));
    });

    const savedPatterns = createSavedPatternService({ store: options.store, mapping, access, references: storedReferences, audit: auditSink, cursors: listCursors });
    app.get('/v1/patterns', { config: { permission: 'principal' } }, async (request) => {
      const query = patternListQuerySchema.safeParse(request.query);
      if (!query.success || (request.body !== undefined && request.body !== null)) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      return patternListResponseSchema.parse(await savedPatterns.list({ traceId: request.id, principal: identity.principal, sourceId: query.data.sourceId, limit: query.data.limit, cursor: query.data.cursor }));
    });
    app.put('/v1/patterns/:id', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = changePatternRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const changed = savedPatternSchema.parse(await savedPatterns.change({ traceId: request.id, principal: identity.principal, id: params.data.id, request: body.data }));
      return reply.header('etag', `"${changed.version}"`).send(changed);
    });
    app.delete('/v1/patterns/:id', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !expected.success || (request.body !== undefined && request.body !== null)) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await savedPatterns.delete({ traceId: request.id, principal: identity.principal, id: params.data.id, expectedVersion: expected.data });
      return reply.header('etag', `"${answer.version}"`).send(deletePatternResponseSchema.parse(answer));
    });
    app.post('/v1/patterns', { config: { permission: 'principal' } }, async (request, reply) => {
      const body = savePatternRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const saved = savedPatternSchema.parse(await savedPatterns.save({ traceId: request.id, principal: identity.principal, request: body.data }));
      return reply.code(201).header('etag', `"${saved.version}"`).send(saved);
    });

    const views = createViewService({ store: options.store, references: storedReferences, mapping, cursors: listCursors });
    app.post('/v1/investigations/:id/views', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      const body = saveViewRequestSchema.safeParse(request.body);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || !expected.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await views.save({ id: params.data.id, principal: identity.principal, expectedDraftVersion: expected.data, request: body.data });
      return reply.code(201).header('etag', `"${answer.draft.version}"`).send(saveViewResponseSchema.parse(answer));
    });

    const ownedViews = createOwnedViewService({ store: options.store, access, references: storedReferences, cursors: listCursors });
    app.get('/v1/views', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const query = viewListQuerySchema.safeParse(request.query);
      if (!query.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await ownedViews.list({ principal: identity.principal, limit: query.data.limit, cursor: query.data.cursor });
      return ownedViewListResponseSchema.parse(answer);
    });

    app.get('/v1/investigations/:id/views', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const params = profileParamsSchema.safeParse(request.params);
      const query = viewListQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await views.list({ id: params.data.id, principal: identity.principal, limit: query.data.limit, cursor: query.data.cursor });
      return viewListResponseSchema.parse(answer);
    });

    const viewParamsSchema = z.strictObject({ id: z.string(), viewId: z.string() });
    app.put('/v1/investigations/:id/views/:viewId', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = viewParamsSchema.safeParse(request.params);
      const body = renameViewRequestSchema.safeParse(request.body);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || !expected.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await views.rename({ id: params.data.id, viewId: params.data.viewId, principal: identity.principal, expectedVersion: expected.data, name: body.data.name });
      return reply.header('etag', `"${answer.version}"`).send(namedViewSchema.parse(answer));
    });

    app.post('/v1/investigations/:id/views/:viewId/delete', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = viewParamsSchema.safeParse(request.params);
      const body = deleteViewRequestSchema.safeParse(request.body ?? {});
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !body.success || !expected.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await views.delete({ id: params.data.id, viewId: params.data.viewId, principal: identity.principal, expectedVersion: expected.data, note: body.data.note ?? null });
      return reply.header('etag', `"${answer.version}"`).send(deleteViewResponseSchema.parse(answer));
    });

    app.post('/v1/investigations/:id/views/:viewId/restore', { config: { permission: 'principal' } }, async (request, reply) => {
      const params = viewParamsSchema.safeParse(request.params);
      const expected = ifMatchSchema.safeParse(request.headers['if-match']);
      if (!noQuerySchema.safeParse(request.query).success || !params.success || !expected.success || (request.body !== undefined && request.body !== null)) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await views.restore({ id: params.data.id, viewId: params.data.viewId, principal: identity.principal, expectedDraftVersion: expected.data });
      return reply.header('etag', `"${answer.draft.version}"`).send(restoreViewResponseSchema.parse(answer));
    });

    app.get('/v1/investigations/:id', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request, reply) => {
      const params = profileParamsSchema.safeParse(request.params);
      if (!noQuerySchema.safeParse(request.query).success || !params.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.read({ id: params.data.id, principal: identity.principal });
      return reply.header('etag', `"${answer.investigation.version}"`).send(investigationResponseSchema.parse(answer));
    });
  }

  appSeams.set(app, options.seams ?? communitySeams());

  return app;
}
