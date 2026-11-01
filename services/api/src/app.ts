import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import fastifyStatic from '@fastify/static';
import { type ErrorCode, healthResponseSchema, meResponseSchema, readyResponseSchema } from '@neburyx/contracts';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { codeForFailure, detailsOf, errorResponse, errorStatus } from './errors.js';
import type { AppStore } from './app-store.js';
import { readinessResponse } from './health/readiness.js';

export interface AppOptions {
  readonly webRoot: string;
  readonly logger: FastifyBaseLogger;
  readonly store: AppStore;
}

const API_PREFIX = '/v1';
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
    requestIdHeader: false,
    frameworkErrors: (_error, request, reply) => {
      sendApiError(reply, request, 'INVALID_REQUEST');
      logCompleted(request, reply, false);
    },
    clientErrorHandler: (_error, socket) => {
      if (socket.writable) answerParserFailure(socket);
    },
  });

  app.addHook('onClose', async () => {
    await options.store.close();
  });

  await app.register(fastifyStatic, { root: options.webRoot });

  const routes: { readonly method: string; readonly url: string }[] = [];
  apiRoutes.set(app, routes);
  const getRoutesWithHead = new Set<string>();
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(API_PREFIX) && !PROBE_PATHS.has(route.url)) return;
    const headIsGenerated = getRoutesWithHead.has(route.url);
    for (const method of [route.method].flat()) {
      if (method === 'GET' && route.exposeHeadRoute !== false) getRoutesWithHead.add(route.url);
      if (!(method === 'HEAD' && headIsGenerated)) routes.push({ method, url: route.url });
    }
  });

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

  app.get('/healthz', async () => healthResponseSchema.parse({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const { statusCode, body } = readinessResponse(await options.store.readiness());
    return reply.code(statusCode).send(readyResponseSchema.parse(body));
  });

  app.get('/v1/me', { exposeHeadRoute: false }, async () => meResponseSchema.parse({ ...(await options.store.current()), sources: [] }));

  return app;
}
