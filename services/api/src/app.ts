import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import fastifyStatic from '@fastify/static';
import { type ErrorCode, entityPathSchema, entityQuerySchema, healthResponseSchema, investigationResponseSchema, meResponseSchema, nodeSchema, openInvestigationRequestSchema, openInvestigationResponseSchema, readyResponseSchema, sourceProfileSchema, sourceTestReportSchema, sourcesResponseSchema } from '@neburyx/contracts';
import { z } from 'zod';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { AppError, codeForFailure, detailsOf, errorResponse, errorStatus } from './errors.js';
import type { AppStore } from './app-store.js';
import { createEntityReader } from './entities/entity-reader.js';
import { createInvestigationService } from './investigations/investigation-service.js';
import type { Gate } from './gate/types.js';
import type { JobRunner } from './jobs/runner.js';
import type { MappingModel } from './mapping/model.js';
import { buildSourceProfile } from './registry/profile.js';
import { matchesEntityTag } from './registry/etag.js';
import { identityHashOf } from './registry/identity-hash.js';
import { summariesOf } from './registry/summary.js';
import { readinessResponse } from './health/readiness.js';
import { communitySeams } from './seams/community-seams.js';
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
  readonly mapping?: MappingModel | undefined;
  readonly sourceTester?: SourceTester | undefined;
  readonly gate?: Gate | undefined;
  readonly reachability?: ReachabilityView | undefined;
  readonly stopPing?: (() => void) | undefined;
  readonly drainPing?: (() => Promise<void>) | undefined;
  readonly closeSources?: (() => Promise<void>) | undefined;
}

const API_PREFIX = '/v1';
/** The router answers a path parameter longer than its limit as an unknown route (404). No limit here leaves the length of a stable ID to its schema, which answers INVALID_REQUEST, and the length of the whole request line to the HTTP parser. */
const NO_PATH_PARAMETER_LIMIT = Number.MAX_SAFE_INTEGER;
const noQuerySchema = z.strictObject({});
const profileParamsSchema = z.strictObject({ id: z.string() });
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
  return reply
    .header(TRACE_HEADER, request.id)
    .code(errorStatus(code))
    .send(errorResponse(code, request.id, details));
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

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const completed = new WeakSet<FastifyRequest>();
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
    reply.raw.once('close', () => logCompleted(request, reply, !reply.raw.writableFinished));
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

  app.get('/v1/me', { exposeHeadRoute: false, config: { permission: 'principal' } }, async () => {
    const [identity, rows] = await Promise.all([options.store.current(), options.store.listSources()]);
    const sources = summariesOf(rows, mapping).map((source) => ({ sourceId: source.id, viewSensitive: true, synthetic: source.synthetic }));
    return meResponseSchema.parse({ ...identity, sources });
  });

  app.get('/v1/sources', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
    if (!noQuerySchema.safeParse(request.query).success) throw new AppError('INVALID_REQUEST');
    const rows = await options.store.listSources();
    const checked = mapping.sources.map((source) => ({ id: source.id, identityHash: identityHashOf(source), configHash: source.configHash }));
    const latest = await options.store.latestChecksFor(checked, (sourceId) => options.logger.warn({ event: 'source.check_unreadable', sourceId }, 'a stored check could not be read'));
    return sourcesResponseSchema.parse({ items: summariesOf(rows, mapping, new Map(latest.map((check) => [check.sourceId, check.report]))), nextCursor: null });
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
    const report = await options.sourceTester.run({ traceId: request.id, principal: identity.principal, sourceId: params.data.id });
    return sourceTestReportSchema.parse(report);
  });

  if (options.gate !== undefined) {
    const entities = createEntityReader({ gate: options.gate, mapping });
    app.get('/v1/entities/:sourceId/:entityType/:stableId', { exposeHeadRoute: false, config: { permission: 'principal' } }, async (request) => {
      const path = entityPathSchema.safeParse(request.params);
      const query = entityQuerySchema.safeParse(request.query);
      if (!path.success || !query.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const node = await entities.read({ traceId: request.id, principal: identity.principal, ...path.data, mask: query.data.mask === 'true' });
      return nodeSchema.parse(node);
    });

    const investigations = createInvestigationService({ store: options.store, entities, mapping });
    app.post('/v1/investigations', { config: { permission: 'principal' } }, async (request, reply) => {
      const body = openInvestigationRequestSchema.safeParse(request.body);
      if (!noQuerySchema.safeParse(request.query).success || !body.success) throw new AppError('INVALID_REQUEST');
      const identity = await options.store.current();
      const answer = await investigations.open({ traceId: request.id, principal: identity.principal, request: body.data });
      return reply
        .code(answer.created ? 201 : 200)
        .header('etag', `"${answer.body.investigation.version}"`)
        .send(openInvestigationResponseSchema.parse(answer.body));
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
