import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';

export interface AppOptions {
  readonly webRoot: string;
  readonly logger: FastifyBaseLogger;
}

const API_PREFIX = '/v1';
const TRACE_HEADER = 'x-trace-id';
const UNMATCHED_ROUTE = 'unmatched';
const UNHANDLED_ERROR_KIND = 'unhandled_error';

function newTraceId(): string {
  return `tr-${randomUUID()}`;
}

function errorBody(statusCode: number): { readonly statusCode: number; readonly error: string | undefined } {
  return { statusCode, error: STATUS_CODES[statusCode] };
}

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}

function sendError(reply: FastifyReply, request: FastifyRequest, statusCode: number): FastifyReply {
  return reply.header(TRACE_HEADER, request.id).code(statusCode).send(errorBody(statusCode));
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const completed = new WeakSet<FastifyRequest>();
  const unmatched = new WeakSet<FastifyRequest>();
  const inFlight = new WeakMap<Socket, { readonly request: FastifyRequest; readonly reply: FastifyReply }>();

  function logCompleted(request: FastifyRequest, reply: FastifyReply, aborted: boolean, statusCode?: number): void {
    if (completed.has(request)) return;
    completed.add(request);
    if (inFlight.get(request.raw.socket)?.request === request) inFlight.delete(request.raw.socket);
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

  function answerParserFailure(socket: Socket): void {
    const current = inFlight.get(socket);
    const traceId = current?.request.id ?? newTraceId();
    const body = JSON.stringify(errorBody(400));
    if (current) logCompleted(current.request, current.reply, false, 400);
    else {
      options.logger.info(
        { event: 'request.completed', traceId, method: 'unknown', route: UNMATCHED_ROUTE, statusCode: 400, durationMs: 0 },
        'request completed',
      );
    }
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nx-trace-id: ${traceId}\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  }

  const app = Fastify({
    loggerInstance: options.logger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'traceId' }),
    genReqId: newTraceId,
    requestIdHeader: false,
    frameworkErrors: (_error, request, reply) => {
      sendError(reply, request, 400);
      logCompleted(request, reply, false);
    },
    clientErrorHandler: (_error, socket) => {
      if (socket.writable) answerParserFailure(socket);
    },
  });

  await app.register(fastifyStatic, { root: options.webRoot });

  app.addHook('onRequest', async (request, reply) => {
    inFlight.set(request.raw.socket, { request, reply });
    reply.header(TRACE_HEADER, request.id);
    reply.raw.once('close', () => logCompleted(request, reply, !reply.raw.writableFinished));
    const servedByApiRoute = request.routeOptions.url?.startsWith(API_PREFIX) ?? false;
    if (isApiPath(request.url) && !servedByApiRoute) {
      unmatched.add(request);
      return sendError(reply, request, 404);
    }
    return undefined;
  });

  app.addHook('onResponse', async (request, reply) => {
    logCompleted(request, reply, false);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = clientErrorStatus(error) ?? 500;
    if (statusCode === 500) {
      request.log.error({ event: 'request.failed', errorKind: UNHANDLED_ERROR_KIND }, 'request failed');
    }
    return sendError(reply, request, statusCode);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const servesPage = (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url);
    if (!servesPage) return sendError(reply, request, 404);
    return reply.sendFile('index.html');
  });

  return app;
}
