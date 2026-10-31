import { rmSync } from 'node:fs';
import { connect } from 'node:net';
import { Duplex, Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { createLogger } from './logger.js';
import { makeWebRoot } from './test-support.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const EMAIL = 'jane.doe@example.com';
const NATIONAL_ID = '123-45-6789';
const IBAN = 'GB82WEST12345698765432';
const TOKEN = 'secret-token-abc';
const SESSION = 's3cr3t-session';
const ACCOUNT = 'ACC-12345';
const TRACE_ID = /^tr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const logLineSchema = z.object({
  event: z.string().optional(),
  traceId: z.string().optional(),
  route: z.string().optional(),
  statusCode: z.number().optional(),
  method: z.string().optional(),
  durationMs: z.number().optional(),
  errorKind: z.string().optional(),
  label: z.string().optional(),
  aborted: z.boolean().optional(),
});
type LogLine = z.infer<typeof logLineSchema>;

let output: string[] = [];
let waiters: { readonly matches: (line: LogLine) => boolean; readonly done: () => void }[] = [];

beforeEach(() => {
  output = [];
  waiters = [];
});

function record(chunk: string): void {
  output.push(chunk);
  const line = logLineSchema.parse(JSON.parse(chunk));
  waiters = waiters.filter((waiter) => {
    if (!waiter.matches(line)) return true;
    waiter.done();
    return false;
  });
}

function logLines(): LogLine[] {
  return output.map((line) => logLineSchema.parse(JSON.parse(line)));
}

function lineWritten(matches: (line: LogLine) => boolean): Promise<void> {
  if (logLines().some(matches)) return Promise.resolve();
  return new Promise((done) => waiters.push({ matches, done }));
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

async function app(): ReturnType<typeof buildApp> {
  const server = await buildApp({ webRoot, logger: createLogger({ write: record }) });
  server.get('/v1/test/query', async () => ({ ok: true }));
  server.post('/v1/test/echo', async () => ({ ok: true }));
  server.get('/v1/test/boom', async () => {
    throw Object.assign(new Error(`failed for ${EMAIL} ${IBAN}`), { name: `Error-${NATIONAL_ID}` });
  });
  server.post('/v1/test/log-input', async (request) => {
    request.log.info({ body: request.body, query: request.query, headers: request.headers }, 'logged by mistake');
    request.log.warn({ err: new Error(`failed for ${EMAIL}`), req: { url: request.url } }, 'also by mistake');
    return { ok: true };
  });
  server.route({
    method: ['GET', 'HEAD'],
    url: '/v1/test/stream-error',
    handler: async (_request, reply) => {
      const stream = new Readable({ read: () => undefined });
      stream.push('first chunk');
      setImmediate(() => stream.destroy(new Error(`stream failed for ${EMAIL} ${IBAN}`)));
      return reply.send(stream);
    },
  });
  return server;
}

function expectNoneOf(values: readonly string[]): void {
  const text = output.join('');
  for (const value of values) expect(text).not.toContain(value);
}

function completedLines(): LogLine[] {
  return logLines().filter((line) => line.event === 'request.completed');
}

function onlyCompletedLine(): LogLine {
  const lines = completedLines();
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) throw new Error('no completion line');
  return line;
}

describe('values that must stay out of the logs', () => {
  it('keeps the query string, body, Authorization and Cookie out', async () => {
    const server = await app();
    await server.inject({
      method: 'POST',
      url: `/v1/test/echo?email=${EMAIL}&id=${NATIONAL_ID}`,
      headers: { authorization: `Bearer ${TOKEN}`, cookie: `session=${SESSION}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Jane Doe', iban: IBAN, email: EMAIL }),
    });
    await server.inject({ method: 'GET', url: `/v1/test/query?email=${EMAIL}&iban=${IBAN}` });
    expectNoneOf([EMAIL, NATIONAL_ID, IBAN, TOKEN, SESSION, 'Jane Doe']);
    expect(logLines().map((line) => line.route)).toEqual(['/v1/test/echo', '/v1/test/query']);
  });

  it('redacts a body, query, headers and error that a handler logs by mistake', async () => {
    const server = await app();
    await server.inject({
      method: 'POST',
      url: `/v1/test/log-input?email=${EMAIL}`,
      headers: { authorization: `Bearer ${TOKEN}`, cookie: `session=${SESSION}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ iban: IBAN, id: NATIONAL_ID }),
    });
    expectNoneOf([EMAIL, NATIONAL_ID, IBAN, TOKEN, SESSION]);
    expect(output.join('')).toContain('[redacted]');
  });

  it.each(['GET', 'HEAD'] as const)('keeps a failing %s response stream’s error text out', async (method) => {
    const server = await app();
    // inject rejects when the stream is destroyed mid-response; the log is what this test reads
    await server.inject({ method, url: '/v1/test/stream-error' }).catch(() => undefined);
    await server.close();
    expectNoneOf([EMAIL, IBAN, 'stream failed']);
  });

  it('logs an unmatched path as "unmatched" and never the path', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/v1/entities/${ACCOUNT}` });
    expect(response.statusCode).toBe(404);
    expect(onlyCompletedLine().route).toBe('unmatched');
    expectNoneOf([ACCOUNT, '/v1/entities']);
  });

  it('logs a fixed category for an error and none of its name, message or stack', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/v1/test/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(EMAIL);
    const failed = logLines().filter((line) => line.event === 'request.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorKind: 'unhandled_error', traceId: response.headers['x-trace-id'] });
    expectNoneOf([EMAIL, IBAN, NATIONAL_ID, 'Error-']);
  });

  it('answers malformed JSON with 400, a trace header and a matching log line', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: `{"email":"${EMAIL}",`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(onlyCompletedLine()).toMatchObject({ statusCode: 400, traceId: response.headers['x-trace-id'] });
    expectNoneOf([EMAIL]);
  });

  it('answers an unsupported content type with 415, a trace header and a matching log line', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/x-unsupported' },
      payload: IBAN,
    });
    expect(response.statusCode).toBe(415);
    expect(response.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(onlyCompletedLine()).toMatchObject({ statusCode: 415, traceId: response.headers['x-trace-id'] });
    expectNoneOf([IBAN]);
  });

  it('answers a malformed URL with a bare 400, a trace header and a matching log line', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/v1/entities/${ACCOUNT}/%zz` });
    expect(response.statusCode).toBe(400);
    expect(response.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(response.body).not.toContain(ACCOUNT);
    expect(JSON.parse(response.body)).toEqual({ statusCode: 400, error: 'Bad Request' });
    expect(onlyCompletedLine()).toMatchObject({ statusCode: 400, route: 'unmatched', traceId: response.headers['x-trace-id'] });
    expectNoneOf([ACCOUNT, '%zz']);
  });
});

describe('failures before a request exists', () => {
  it('answers an HTTP parser failure with a trace header and a matching log line', async () => {
    const server = await app();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    const closed = new Promise<void>((done) => socket.on('close', () => done()));
    socket.write(`GARBAGE ${EMAIL}\r\n\r\n`);
    await closed;
    await server.close();
    const text = Buffer.concat(received).toString('utf8');
    expect(text.startsWith('HTTP/1.1 400 Bad Request')).toBe(true);
    const traceId = /x-trace-id: (tr-[0-9a-f-]{36})/.exec(text)?.[1];
    expect(traceId).toMatch(TRACE_ID);
    expect(onlyCompletedLine()).toMatchObject({ statusCode: 400, traceId });
    expectNoneOf([EMAIL]);
  });

  it('writes exactly one completion line for a request the client abandons', async () => {
    const server = await app();
    const entered = deferred();
    const release = deferred();
    server.get('/v1/test/hold', async () => {
      entered.release();
      await release.promise;
      return { ok: true };
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const socket = connect(port, '127.0.0.1');
    socket.write('GET /v1/test/hold HTTP/1.1\r\nhost: x\r\n\r\n');
    await entered.promise;
    socket.destroy();
    await lineWritten((line) => line.event === 'request.completed');
    release.release();
    await server.close();
    expect(onlyCompletedLine()).toMatchObject({ aborted: true, route: '/v1/test/hold' });
  });
});

describe('requests that fail after they were created', () => {
  async function listening(
    addRoutes: (server: Awaited<ReturnType<typeof app>>) => void,
  ): Promise<{ readonly server: Awaited<ReturnType<typeof app>>; readonly port: number }> {
    const server = await app();
    addRoutes(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    return { server, port: typeof address === 'object' && address !== null ? address.port : 0 };
  }

  it('writes exactly one completion line when the client leaves after its body was read', async () => {
    const entered = deferred();
    const release = deferred();
    const { server, port } = await listening((added) => {
      added.post('/v1/test/hold-body', async () => {
        entered.release();
        await release.promise;
        return { ok: true };
      });
    });
    const socket = connect(port, '127.0.0.1');
    socket.write('POST /v1/test/hold-body HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
    await entered.promise;
    socket.destroy();
    await lineWritten((line) => line.event === 'request.completed');
    release.release();
    await server.close();
    expect(onlyCompletedLine()).toMatchObject({ aborted: true, route: '/v1/test/hold-body' });
  });

  it('answers malformed chunked framing with the request’s own trace ID and one completion line', async () => {
    const { server, port } = await listening((added) => {
      added.post('/v1/test/hold-body', async () => ({ ok: true }));
    });
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    const closed = new Promise<void>((done) => socket.on('close', () => done()));
    socket.write(`POST /v1/test/hold-body HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\nZZ ${EMAIL}\r\n`);
    await closed;
    await server.close();
    const text = Buffer.concat(received).toString('utf8');
    const traceId = /x-trace-id: (tr-[0-9a-f-]{36})/.exec(text)?.[1];
    expect(text.startsWith('HTTP/1.1 400 Bad Request')).toBe(true);
    expect(traceId).toMatch(TRACE_ID);
    expect(completedLines().map((line) => line.traceId)).toEqual([traceId]);
    expect(onlyCompletedLine()).toMatchObject({ statusCode: 400, route: '/v1/test/hold-body' });
    expectNoneOf([EMAIL]);
  });
});

describe('pipelined requests', () => {
  function memorySocket(): { readonly socket: Duplex; readonly received: Buffer[] } {
    const received: Buffer[] = [];
    const socket = new Duplex({
      read: () => undefined,
      write: (chunk: Buffer, _encoding, callback) => {
        received.push(chunk);
        callback();
      },
    });
    Object.assign(socket, {
      setTimeout: () => socket,
      setNoDelay: () => socket,
      setKeepAlive: () => socket,
      remoteAddress: '127.0.0.1',
    });
    return { socket, received };
  }

  it('answers the second request’s malformed framing with its own trace ID after the first completed', async () => {
    const server = await app();
    const releaseFirst = deferred();
    const secondCreated = deferred();
    let secondId = '';
    server.get('/v1/test/first', async () => {
      await releaseFirst.promise;
      return { ok: true };
    });
    server.post('/v1/test/second', async () => ({ ok: true }));
    server.addHook('onRequest', async (request) => {
      if (request.url !== '/v1/test/second') return;
      secondId = request.id;
      secondCreated.release();
    });
    await server.ready();

    const { socket, received } = memorySocket();
    const closed = new Promise<void>((done) => socket.on('close', () => done()));
    server.server.emit('connection', socket);
    socket.push(
      'GET /v1/test/first HTTP/1.1\r\nhost: x\r\n\r\n' +
        'POST /v1/test/second HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n',
    );
    await secondCreated.promise;
    releaseFirst.release();
    await lineWritten((line) => line.event === 'request.completed' && line.route === '/v1/test/first');
    socket.push('ZZ\r\n');
    await lineWritten((line) => line.event === 'request.completed' && line.statusCode === 400);
    socket.destroy();
    await closed;

    const text = Buffer.concat(received).toString('utf8');
    const completed = completedLines();
    expect(completed).toHaveLength(2);
    expect(completed.map((line) => line.statusCode)).toEqual([200, 400]);
    expect(completed[1]?.traceId).toBe(secondId);
    expect(completed.some((line) => line.aborted === true)).toBe(false);
    expect([...text.matchAll(/x-trace-id: (tr-[0-9a-f-]{36})/g)].map((match) => match[1])).toEqual(
      completed.map((line) => line.traceId),
    );
  });
});

describe('trace IDs', () => {
  it('ignores a trace ID or request ID sent by the client', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/v1/test/query',
      headers: { 'x-trace-id': 'tr-sent-by-client', 'x-request-id': 'sent-by-client', 'request-id': 'sent-by-client' },
    });
    expect(response.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(response.headers['x-trace-id']).not.toContain('sent-by-client');
    expectNoneOf(['sent-by-client']);
  });

  it.each([
    ['a matched route', '/v1/test/query', 200],
    ['an unmatched path', '/v1/anything', 404],
    ['a static file', '/assets/app.js', 200],
    ['a client route', '/investigations/abc', 200],
  ])('puts a different trace ID on every response (%s)', async (_name, url, statusCode) => {
    const server = await app();
    const first = await server.inject({ method: 'GET', url });
    const second = await server.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(statusCode);
    expect(first.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(second.headers['x-trace-id']).toMatch(TRACE_ID);
    expect(first.headers['x-trace-id']).not.toBe(second.headers['x-trace-id']);
  });

  it('writes one completion line whose trace ID equals the response header', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/v1/test/query' });
    const line = onlyCompletedLine();
    expect(line).toMatchObject({ traceId: response.headers['x-trace-id'], method: 'GET', route: '/v1/test/query', statusCode: 200 });
    expect(Number.isInteger(line.durationMs)).toBe(true);
  });

  it('keeps each request’s ID on its own lines while both are in flight', async () => {
    const server = await app();
    const gates = { first: deferred(), second: deferred() };
    const entered = { first: deferred(), second: deferred() };
    for (const label of ['first', 'second'] as const) {
      server.get(`/v1/test/overlap-${label}`, async (request) => {
        entered[label].release();
        await gates[label].promise;
        request.log.info({ event: 'test.overlap', label }, 'overlapping handler');
        return { ok: true };
      });
    }
    const first = server.inject({ method: 'GET', url: '/v1/test/overlap-first' });
    const second = server.inject({ method: 'GET', url: '/v1/test/overlap-second' });
    await Promise.all([entered.first.promise, entered.second.promise]);
    gates.second.release();
    gates.first.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const lines = logLines();
    const traceOf = (label: string): string | undefined => lines.find((line) => line.label === label)?.traceId;
    expect(traceOf('first')).toBe(firstResponse.headers['x-trace-id']);
    expect(traceOf('second')).toBe(secondResponse.headers['x-trace-id']);
    expect(firstResponse.headers['x-trace-id']).not.toBe(secondResponse.headers['x-trace-id']);
    expect(
      completedLines()
        .map((line) => line.traceId)
        .sort(),
    ).toEqual([firstResponse.headers['x-trace-id'], secondResponse.headers['x-trace-id']].sort());
  });
});
