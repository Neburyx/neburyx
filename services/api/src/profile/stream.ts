import { EXTENSION_STREAM_MEDIA_TYPE, type ExtensionRouteStream } from '@neburyx/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorResponse } from '../errors.js';
import type { ErrorCode } from '@neburyx/contracts';

/** Whether the `Accept` header of a request names the streamed media type (parameters and case aside). */
export function wantsStream(accept: string | string[] | undefined): boolean {
  const text = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return text.split(',').some((part) => (part.split(';')[0] ?? '').trim().toLowerCase() === EXTENSION_STREAM_MEDIA_TYPE);
}

export interface StreamWriter {
  /** Checks an event of the route against its schema and sends it as one line; an event that does not fit ends the stream with an `error` line instead. */
  readonly emit: (name: string, members: unknown) => void;
  /** Whether a response has been started: after that a failure is a line of the stream, before it an HTTP error. */
  readonly started: () => boolean;
  /** Ends the stream with the answer as its last line (or with the failure of an event that did not fit). */
  finish(answer: unknown): void;
  /** Ends the stream with an `error` line, the members of the HTTP error body of the same code. */
  fail(code: ErrorCode, details?: unknown): void;
  /** Whether the stream has ended, by the answer or a failure. */
  readonly ended: () => boolean;
}

/**
 * Writes one streamed response: the headers at the first line, one JSON object a line, and the end. The response is started only when there is a first line, so a request that fails before it is answered with its HTTP status as any request is. Nothing
 * written here is logged, and a line for a connection that has closed is dropped.
 */
export function createStreamWriter(request: FastifyRequest, reply: FastifyReply, stream: ExtensionRouteStream, onInvalid: () => void): StreamWriter {
  let state: 'idle' | 'open' | 'ended' = 'idle';
  const open = (): void => {
    if (state !== 'idle') return;
    state = 'open';
    reply.hijack();
    reply.raw.writeHead(200, { ...reply.getHeaders(), 'content-type': EXTENSION_STREAM_MEDIA_TYPE, 'cache-control': 'no-store', 'x-accel-buffering': 'no' } as Record<string, string>);
  };
  const write = (value: unknown): void => {
    if (state !== 'open' || reply.raw.destroyed || reply.raw.writableEnded) return;
    reply.raw.write(`${JSON.stringify(value)}\n`);
  };
  const end = (): void => {
    if (state === 'ended') return;
    state = 'ended';
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  };
  const fail = (code: ErrorCode, details?: unknown): void => {
    if (state === 'ended') return;
    open();
    write({ event: 'error', ...errorResponse(code, request.id, details).error });
    end();
  };
  return {
    started: () => state !== 'idle',
    ended: () => state === 'ended',
    emit: (name, members) => {
      if (state === 'ended') return;
      const schema = Object.hasOwn(stream.events, name) ? stream.events[name] : undefined;
      const parsed = schema?.safeParse(members);
      if (parsed === undefined || !parsed.success || typeof parsed.data !== 'object' || parsed.data === null) {
        onInvalid();
        fail('INTERNAL_ERROR');
        return;
      }
      open();
      write({ event: name, ...(parsed.data as Record<string, unknown>) });
    },
    finish: (answer) => {
      if (state === 'ended') return;
      open();
      write({ event: 'answer', answer });
      end();
    },
    fail,
  };
}
