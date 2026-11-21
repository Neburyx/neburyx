import { rmSync } from 'node:fs';
import { ExtensionRefusal, type ExtensionRoute, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const NDJSON = { accept: 'application/x-ndjson' };
const EVENTS = { step: z.strictObject({ n: z.number().int().positive() }) };
const ANSWER = z.strictObject({ status: z.literal('done') });

type Handler = ExtensionRoute['handler'];
const route = (handler: Handler, over: Partial<ExtensionRoute> = {}): ExtensionRoute => ({ method: 'POST', url: '/v1/probe', permission: 'principal', requestSchema: z.strictObject({ text: z.string().min(1) }), responseSchema: ANSWER, stream: { events: EVENTS, maxMs: 5000 }, handler, ...over });

async function started(probe: ExtensionRoute, lines: string[] = []) {
  const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [probe] }] };
  return buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store: memoryAppStore(), mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, extension, previewOn: true });
}
const linesOf = (payload: string): Record<string, unknown>[] => payload.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
const post = (app: Awaited<ReturnType<typeof started>>, headers: Record<string, string> = NDJSON, payload: unknown = { text: 'x' }) => app.inject({ method: 'POST', url: '/v1/probe', headers, payload: payload as never });

describe('a streamed response of an extension route', () => {
  it('sends the events in the order emitted, then the answer as the last line, with the trace header and no caching', async () => {
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      request.emit?.('step', { n: 2 });
      return { status: 'done' };
    }));
    const answer = await post(app);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toBe('application/x-ndjson');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['content-encoding']).toBeUndefined();
    expect(answer.headers['x-trace-id'] ?? answer.headers['x-request-id']).toBeDefined();
    expect(linesOf(answer.payload)).toEqual([{ event: 'step', n: 1 }, { event: 'step', n: 2 }, { event: 'answer', answer: { status: 'done' } }]);
    await app.close();
  });

  it('sends only the answer line when the handler emits nothing', async () => {
    const app = await started(route(async () => ({ status: 'done' })));
    expect(linesOf((await post(app)).payload)).toEqual([{ event: 'answer', answer: { status: 'done' } }]);
    await app.close();
  });

  it('answers a client that did not ask for a stream with the JSON answer as before, and the handler has no emit', async () => {
    let had: boolean | undefined;
    const app = await started(route(async (request) => {
      had = request.emit !== undefined;
      return { status: 'done' };
    }));
    const answer = await post(app, {});
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toContain('application/json');
    expect(answer.json()).toEqual({ status: 'done' });
    expect(had).toBe(false);
    await app.close();
  });

  it('does not send an event that does not fit its schema: the stream ends with an error line and no event follows', async () => {
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      request.emit?.('step', { n: 'SENTINEL-EVENT', extra: 1 });
      request.emit?.('step', { n: 3 });
      return { status: 'done' };
    }));
    const lines = linesOf((await post(app)).payload);
    expect(lines.map((line) => line['event'])).toEqual(['step', 'error']);
    expect(lines[1]).toMatchObject({ event: 'error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(lines)).not.toContain('SENTINEL-EVENT');
    await app.close();
  });

  it('stops the handler through the abort signal after an event that does not fit, so nothing more is done for a turn the client was told failed', async () => {
    let seen!: (aborted: boolean) => void;
    const aborted = new Promise<boolean>((resolve) => { seen = resolve; });
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 'nope' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen(request.signal.aborted);
      return { status: 'done' };
    }));
    await post(app);
    expect(await aborted).toBe(true);
    await app.close();
  });

  it('refuses an event name that is not the route’s, and an event of the core’s own names', async () => {
    for (const name of ['unknown', 'answer', 'error', '__proto__']) {
      const app = await started(route(async (request) => {
        request.emit?.(name, { n: 1 });
        return { status: 'done' };
      }));
      const lines = linesOf((await post(app)).payload);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'error', code: 'INTERNAL_ERROR' });
      await app.close();
    }
  });

  it('answers a request refused before its handler with its HTTP status and error body, not a stream', async () => {
    let ran = false;
    const app = await started(route(async () => {
      ran = true;
      return { status: 'done' };
    }));
    const answer = await post(app, NDJSON, { text: '' });
    expect(answer.statusCode).toBe(400);
    expect(answer.headers['content-type']).toContain('application/json');
    expect(answer.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(ran).toBe(false);
    await app.close();
  });

  it('answers an error before the first event as an HTTP error, and after it as the last line with the code the HTTP body would have', async () => {
    const before = await started(route(async () => {
      throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
    }));
    const refused = await post(before);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    await before.close();
    const after = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
    }));
    const lines = linesOf((await post(after)).payload);
    expect(lines.map((line) => line['event'])).toEqual(['step', 'error']);
    expect(lines[1]).toMatchObject({ event: 'error', code: 'ACCESS_DENIED' });
    await after.close();
    const crash = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      throw new Error('SENTINEL-CRASH');
    }));
    const crashed = await post(crash);
    expect(linesOf(crashed.payload)[1]).toMatchObject({ event: 'error', code: 'INTERNAL_ERROR' });
    expect(crashed.payload).not.toContain('SENTINEL-CRASH');
    await crash.close();
  });

  it('sends an answer that does not fit its schema as the error line, never as an answer', async () => {
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      return { status: 'SENTINEL-ANSWER' };
    }));
    const lines = linesOf((await post(app)).payload);
    expect(lines[1]).toMatchObject({ event: 'error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(lines)).not.toContain('SENTINEL-ANSWER');
    await app.close();
  });

  it('drops an event emitted after the answer, so the answer is the last line', async () => {
    let late: (() => void) | undefined;
    const app = await started(route(async (request) => {
      late = () => request.emit?.('step', { n: 9 });
      return { status: 'done' };
    }));
    const lines = linesOf((await post(app)).payload);
    late?.();
    expect(lines.at(-1)).toEqual({ event: 'answer', answer: { status: 'done' } });
    await app.close();
  });

  it('ends a stream that outlives its limit with an error line and fires the abort signal of the request', async () => {
    let aborted = false;
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      await new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
        setTimeout(resolve, 2000);
      });
      return { status: 'done' };
    }, { stream: { events: EVENTS, maxMs: 50 } }));
    const lines = linesOf((await post(app)).payload);
    expect(lines.map((line) => line['event'])).toEqual(['step', 'error']);
    expect(lines[1]).toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(aborted).toBe(true);
    await app.close();
  });

  it('logs the request once, with status 200 and no event', async () => {
    const logs: string[] = [];
    const app = await started(route(async (request) => {
      request.emit?.('step', { n: 1 });
      return { status: 'done' };
    }), logs);
    await post(app);
    await app.close();
    const completed = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === 'request.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ statusCode: 200 });
    expect(completed[0]).not.toHaveProperty('aborted');
    expect(logs.join('\n')).not.toContain('"n":1');
  });
});

describe('a route that declares a stream, at start-up', () => {
  const handler: Handler = async () => ({ status: 'done' });
  it('is refused when it is also idempotent', async () => {
    await expect(started(route(handler, { idempotent: { sourceOf: () => 'demo' } }))).rejects.toThrow('both a stream and idempotency');
  });

  it.each(['answer', 'error'])('is refused when it declares the event %s, which the application owns', async (name) => {
    await expect(started(route(handler, { stream: { events: { [name]: z.strictObject({}) }, maxMs: 1000 } }))).rejects.toThrow(`declares the event ${name}`);
  });
});

describe('a streamed connection that the client closes', () => {
  it('stops the handler through the abort signal, writes nothing more and logs no handler failure', async () => {
    const logs: string[] = [];
    let seen = false;
    const finished = new Promise<void>((resolve) => {
      void started(route(async (request) => {
        request.emit?.('step', { n: 1 });
        await new Promise<void>((done) => {
          request.signal.addEventListener('abort', () => {
            seen = true;
            done();
          });
        });
        request.emit?.('step', { n: 2 });
        resolve();
        return { status: 'done' };
      }), logs).then(async (app) => {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const controller = new AbortController();
        const response = await fetch(`${address}/v1/probe`, { method: 'POST', headers: { ...NDJSON, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }), signal: controller.signal });
        const reader = response.body?.getReader();
        await reader?.read();
        controller.abort();
        await finished;
        await new Promise((r) => setTimeout(r, 50));
        await app.close();
      });
    });
    await finished;
    expect(seen).toBe(true);
    const parsed = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.some((line) => line['event'] === 'extension.handler_failed')).toBe(false);
    expect(parsed.filter((line) => line['event'] === 'request.completed')).toMatchObject([{ aborted: true }]);
  });
});
