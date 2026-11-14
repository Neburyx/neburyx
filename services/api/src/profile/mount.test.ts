import { rmSync } from 'node:fs';
import { ExtensionRefusal, type AuditEvent, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AppError } from '../errors.js';
import { mountExtensionRoutes } from './mount.js';
import { createLogger } from '../logger.js';
import { communityAskClassifier, communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const URL_OF_ROUTE = '/v1/probe';

function extensionOf(handler: (request: ExtensionRequest) => Promise<unknown>): ProfileExtension {
  return { name: 'probe', routeGroups: [{ routes: [{ method: 'GET', url: URL_OF_ROUTE, permission: 'principal', responseSchema: z.unknown(), handler }] }] };
}

async function started(extension: ProfileExtension, options: { readonly previewOn?: boolean; readonly record?: (event: AuditEvent) => Promise<void>; readonly app?: Partial<Parameters<typeof buildApp>[0]> } = {}) {
  const lines: string[] = [];
  const events: AuditEvent[] = [];
  const community = communitySeams();
  const seams: Seams = { ...community, audit: { record: options.record ?? (async (event) => void events.push(event)) } };
  const app = await buildApp({
    webRoot,
    logger: createLogger({ write: (line) => void lines.push(line) }),
    store: memoryAppStore(),
    seams,
    extension,
    ...(options.previewOn === undefined ? {} : { previewOn: options.previewOn }),
    ...options.app,
  });
  return { app, lines, events };
}

const REFUSAL = { code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: true } as const;

describe('what the mount gives an extension handler', () => {
  it('gives the five fields: the principal, its role, the switch, the trace ID and the application sink', async () => {
    let seen: ExtensionRequest | undefined;
    const { app, events } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect(answer.statusCode).toBe(200);
    const { principal } = await memoryAppStore().current();
    expect(seen).toMatchObject({ previewOn: true, traceId: answer.headers['x-trace-id'], principalId: principal.id, principalRole: principal.role });
    const event: AuditEvent = { actorId: 'a', actorRole: null, action: 'x', result: 'success', traceId: 't' };
    await seen?.audit.record(event);
    expect(events).toEqual([event]);
    await app.close();
  });

  it('gives no runner of Ask when the application has no gate to read through, and no search tools either', async () => {
    let seen: ExtensionRequest | undefined;
    let abortedWhileHandling: boolean | undefined;
    const { app } = await started(extensionOf(async (request) => ((seen = request), (abortedWhileHandling = request.signal.aborted), 'ok')), { previewOn: true });
    await app.inject({ url: URL_OF_ROUTE });
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty('askRunner');
    expect(abortedWhileHandling).toBe(false);
    expect(seen).not.toHaveProperty('askEntityTools');
    expect(seen).not.toHaveProperty('askPatterns');
    await app.close();
  });

  it('tells the handler the switch is off when the app is told it is off, and when it is told nothing', async () => {
    for (const options of [{ previewOn: false }, {}]) {
      const seen: boolean[] = [];
      const { app } = await started(extensionOf(async (request) => (seen.push(request.previewOn), 'ok')), options);
      await app.inject({ url: URL_OF_ROUTE });
      expect(seen).toEqual([false]);
      await app.close();
    }
  });

  it('hands a failed audit write to the handler as a rejection, unchanged', async () => {
    const failure = new Error('write failed');
    let caught: unknown;
    const { app } = await started(
      extensionOf(async (request) => {
        try {
          await request.audit.record({ actorId: 'a', actorRole: null, action: 'x', result: 'success', traceId: 't' });
        } catch (error) {
          caught = error;
        }
        return 'ok';
      }),
      { previewOn: true, record: async () => Promise.reject(failure) },
    );
    expect((await app.inject({ url: URL_OF_ROUTE })).statusCode).toBe(200);
    expect(caught).toBe(failure);
    await app.close();
  });
});

describe('what the mount answers to a refusal', () => {
  const asRefusal = [
    ['a refusal of this copy of the contracts', () => new ExtensionRefusal(REFUSAL)],
    ['a plain object of the same shape, as another copy of the contracts makes it', () => ({ name: 'ExtensionRefusal', ...REFUSAL })],
    ['an error of the same shape from another copy', () => Object.assign(new Error(), { name: 'ExtensionRefusal', ...REFUSAL })],
  ] as const;

  it.each(asRefusal)('answers 403 ACCESS_DENIED with the reason, its sentence and the trace ID for %s', async (_name, make) => {
    const { app } = await started(extensionOf(async () => Promise.reject(make())), { previewOn: false });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toEqual({
      error: {
        code: 'ACCESS_DENIED',
        message: 'The AI preview is not switched on for this deployment. The switch is a safety rail that whoever runs the deployment sets, not a lock.',
        retryable: false,
        traceId: answer.headers['x-trace-id'],
        details: { reason: 'ai-preview-off' },
      },
    });
    await app.close();
  });

  it.each([
    ['an ordinary error', () => new Error('secret detail of the failure')],
    ['a refusal with another code', () => ({ name: 'ExtensionRefusal', ...REFUSAL, code: 'CONFLICT' })],
    ['a refusal with another reason', () => ({ name: 'ExtensionRefusal', ...REFUSAL, reason: 'access-changed' })],
    ['a refusal without the audited mark', () => ({ name: 'ExtensionRefusal', code: 'ACCESS_DENIED', reason: 'ai-preview-off' })],
    ['an unknown code', () => ({ name: 'ExtensionRefusal', code: 'TEAPOT' })],
    ['a reason of another code', () => ({ name: 'ExtensionRefusal', code: 'SOURCE_UNAVAILABLE', reason: 'plan-expired' })],
    ['a conflict with a reason that is not a plan one', () => ({ name: 'ExtensionRefusal', code: 'CONFLICT', reason: 'source-changed' })],
    ['a reason on a code that has none', () => ({ name: 'ExtensionRefusal', code: 'ASK_PLAN_INVALID', reason: 'plan-expired' })],
  ] as const)('answers INTERNAL_ERROR and logs the event name only for %s', async (_name, make) => {
    const { app, lines } = await started(extensionOf(async () => Promise.reject(make())), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect(answer.statusCode).toBe(500);
    expect(answer.json().error.code).toBe('INTERNAL_ERROR');
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line['event'] === 'extension.handler_failed');
    expect(logged).toMatchObject({ event: 'extension.handler_failed', extension: 'probe' });
    expect(lines.join('\n')).not.toContain('secret detail');
    await app.close();
  });

  it('answers the 403 and logs one line without event data for a refusal whose own audit event was not written', async () => {
    const { app, lines } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal({ ...REFUSAL, audited: false }))), { previewOn: false });
    expect((await app.inject({ url: URL_OF_ROUTE })).statusCode).toBe(403);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === 'extension.audit_failed');
    expect(logged).toHaveLength(1);
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual(['event', 'extension', 'hostname', 'level', 'msg', 'pid', 'time', 'traceId'].sort());
    await app.close();
  });

  it('logs no audit failure for a refusal that was audited', async () => {
    const { app, lines } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal(REFUSAL))), { previewOn: false });
    await app.inject({ url: URL_OF_ROUTE });
    expect(lines.join('\n')).not.toContain('extension.audit_failed');
    await app.close();
  });
});

describe('a POST route of an extension', () => {
  const BODY_SCHEMA = z.strictObject({ message: z.string().min(1) });
  const postExtension = (handler: (request: ExtensionRequest) => Promise<unknown>): ProfileExtension => ({
    name: 'probe',
    routeGroups: [{ routes: [{ method: 'POST', url: URL_OF_ROUTE, permission: 'principal', requestSchema: BODY_SCHEMA, responseSchema: z.unknown(), handler }] }],
  });

  it('gives the handler the parsed body and the application classifier', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(postExtension(async (request) => ((seen = request), 'ok')), { previewOn: true });
    const answer = await app.inject({ method: 'POST', url: URL_OF_ROUTE, payload: { message: 'hello' } });
    expect(answer.statusCode).toBe(200);
    expect(seen).toMatchObject({ body: { message: 'hello' } });
    expect(seen?.askClassifier.availability()).toEqual({ available: false, reason: 'not_in_this_edition' });
    await app.close();
  });

  it.each([['a body that is missing', undefined], ['a field of another name', { message: 'x', secret: 'SENTINEL-VALUE' }], ['an empty message', { message: '' }], ['a message that is not text', { message: 'SENTINEL-VALUE'.length }]])('answers INVALID_REQUEST for %s without running the handler or writing a value to the answer or the log', async (_name, payload) => {
    let ran = 0;
    const { app, lines } = await started(postExtension(async () => (ran++, 'ok')), { previewOn: true });
    const answer = await app.inject({ method: 'POST', url: URL_OF_ROUTE, ...(payload === undefined ? {} : { payload }) });
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error.code).toBe('INVALID_REQUEST');
    expect(ran).toBe(0);
    expect(answer.body + lines.join('')).not.toContain('SENTINEL');
    await app.close();
  });
});

describe('a refusal that cannot be answered here', () => {
  it('answers 422 ASK_UNSUPPORTED with its reason and sentence, writes no audit event and logs no failed audit', async () => {
    const { app, lines, events } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' }))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error).toMatchObject({ code: 'ASK_UNSUPPORTED', message: 'Ask is not available in this edition.', retryable: false, details: { reason: 'not-in-this-edition' } });
    expect(events).toEqual([]);
    expect(lines.filter((line) => line.includes('extension.audit_failed'))).toEqual([]);
    await app.close();
  });
});

describe('a refusal that names a thing that is not there', () => {
  it('answers 404 NOT_FOUND, writes no audit event and logs no failed audit', async () => {
    const { app, lines, events } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal({ code: 'NOT_FOUND' }))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect([answer.statusCode, answer.json().error.code]).toEqual([404, 'NOT_FOUND']);
    expect(events).toEqual([]);
    expect(lines.filter((line) => line.includes('extension.audit_failed'))).toEqual([]);
    await app.close();
  });
});


describe('what the mount gives an extension to sign with', () => {
  it('gives a signing function and no key bytes', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true });
    await app.inject({ url: URL_OF_ROUTE });
    expect(seen?.signText?.('a text')).toMatch(/^[0-9a-f]{64}$/);
    const values = Object.values(seen ?? {});
    expect(values.some((value) => value instanceof Uint8Array)).toBe(false);
    await app.close();
  });

  it('signs the same text the same way with the same key and differently with another key', async () => {
    const macOf = async (signingKey: Buffer) => {
      let seen: ExtensionRequest | undefined;
      const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true, app: { signingKey } });
      await app.inject({ url: URL_OF_ROUTE });
      await app.close();
      return seen?.signText?.('a text');
    };
    const first = await macOf(Buffer.alloc(32, 1));
    expect(await macOf(Buffer.alloc(32, 1))).toBe(first);
    expect(await macOf(Buffer.alloc(32, 2))).not.toBe(first);
  });

  it('keeps the code of an error of the application that an extension lets through', async () => {
    const { app } = await started(extensionOf(async () => Promise.reject(new AppError('RATE_LIMITED'))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect([answer.statusCode, answer.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    await app.close();
  });

  it('answers QUERY_TIMEOUT with the limit for the refusal of a call that ran out of time', async () => {
    const { app } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 20_000 }))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect([answer.json().error.code, answer.json().error.details]).toEqual(['QUERY_TIMEOUT', { timeoutMs: 20_000 }]);
    await app.close();
  });
});

describe('which classifier an extension route is given', () => {
  const stubClassifier = { availability: () => ({ available: true as const }), classify: () => Promise.reject(new Error('not used')) };

  function withClassifier(extensionClassifier: (() => typeof stubClassifier | undefined) | undefined): ProfileExtension {
    return { ...extensionOf(async (request) => request.askClassifier.availability()), ...(extensionClassifier === undefined ? {} : { askClassifier: extensionClassifier }) };
  }

  async function availabilityWith(extension: ProfileExtension, seamsClassifier?: typeof stubClassifier): Promise<unknown> {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), seams: { ...communitySeams(), ...(seamsClassifier === undefined ? {} : { askClassifier: seamsClassifier }) }, extension, previewOn: true });
    const answer = (await app.inject({ url: URL_OF_ROUTE })).json();
    await app.close();
    return answer;
  }

  it('is the classifier of the extension when the seams hold the Community default', async () => {
    expect(await availabilityWith(withClassifier(() => stubClassifier))).toEqual({ available: true });
  });

  it('is the classifier of the seams when it is not the Community default, even if the extension has one', async () => {
    const unavailable = { availability: () => ({ available: false as const, reason: 'seam' }), classify: stubClassifier.classify };
    expect(await availabilityWith(withClassifier(() => stubClassifier), unavailable as never)).toEqual({ available: false, reason: 'seam' });
  });

  it('is the Community default when the extension has no classifier yet, or none at all', async () => {
    expect(await availabilityWith(withClassifier(() => undefined))).toEqual({ available: false, reason: 'not_in_this_edition' });
    expect(await availabilityWith(withClassifier(undefined))).toEqual({ available: false, reason: 'not_in_this_edition' });
  });
});

describe('a refusal because the audit event could not be written', () => {
  it('answers 503 AUDIT_UNAVAILABLE with no audit event and no failed-audit warning', async () => {
    const { app, lines, events } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' }))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect([answer.statusCode, answer.json().error.code]).toEqual([503, 'AUDIT_UNAVAILABLE']);
    expect(events).toEqual([]);
    expect(lines.filter((line) => line.includes('extension.audit_failed'))).toEqual([]);
    await app.close();
  });
});

describe('the refusals of a read of the gate', () => {
  const answers: ReadonlyArray<[string, Record<string, unknown>, number, Record<string, unknown> | undefined]> = [
    ['QUERY_BUDGET_EXCEEDED', { code: 'QUERY_BUDGET_EXCEEDED', maxPage: 50, maxHops: 2 }, 422, { maxPage: 50, maxHops: 2 }],
    ['QUERY_TIMEOUT', { code: 'QUERY_TIMEOUT', timeoutMs: 1000 }, 504, { timeoutMs: 1000 }],
    ['SOURCE_BUSY', { code: 'SOURCE_BUSY' }, 503, undefined],
    ['SOURCE_UNAVAILABLE with its reason', { code: 'SOURCE_UNAVAILABLE', reason: 'refused' }, 503, { reason: 'refused' }],
    ['SOURCE_UNAVAILABLE with the wait of the breaker', { code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', retryAfterMs: 4000 }, 503, { reason: 'repeated-timeouts', retryAfterMs: 4000 }],
    ['RATE_LIMITED with its wait', { code: 'RATE_LIMITED', retryAfterMs: 2000 }, 429, { retryAfterMs: 2000 }],
    ['ACCESS_DENIED with no reason', { code: 'ACCESS_DENIED' }, 403, undefined],
    ['NOT_FOUND', { code: 'NOT_FOUND' }, 404, undefined],
    ['SOURCE_MISMATCH', { code: 'SOURCE_MISMATCH' }, 400, undefined],
    ['INVALID_REQUEST with a reason', { code: 'INVALID_REQUEST', reason: 'overlap' }, 400, undefined],
    ['ASK_PLAN_INVALID', { code: 'ASK_PLAN_INVALID' }, 422, undefined],
    ['AUDIT_UNAVAILABLE', { code: 'AUDIT_UNAVAILABLE' }, 503, undefined],
  ];

  it.each(answers)('answers %s with its status and the details the error model allows, writes no audit event and logs no failed audit', async (name, held, status, details) => {
    const { app, lines, events } = await started(extensionOf(async () => Promise.reject(new ExtensionRefusal(held as never))), { previewOn: true });
    const answer = await app.inject({ url: URL_OF_ROUTE });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([status, held['code'], details]);
    expect(events).toEqual([]);
    expect(lines.filter((line) => line.includes('extension.audit_failed'))).toEqual([]);
    expect(name).not.toBe('');
    await app.close();
  });
});

describe('the check of the source that an extension is given', () => {
  async function seenWith(askSourceReadableFor: Parameters<typeof mountExtensionRoutes>[3]['askSourceReadableFor']): Promise<ExtensionRequest | undefined> {
    const app = Fastify();
    let seen: ExtensionRequest | undefined;
    mountExtensionRoutes(app, extensionOf(async (request) => ((seen = request), 'ok')), { current: async () => ({ principal: { id: 'p-1', role: 'investigator' } }) } as never, {
      previewOn: true,
      audit: { record: async () => undefined },
      askClassifier: communityAskClassifier,
      ...(askSourceReadableFor === undefined ? {} : { askSourceReadableFor }),
    });
    await app.inject({ url: URL_OF_ROUTE });
    await app.close();
    return seen;
  }

  it('is the check the application built for this caller and trace', async () => {
    const contexts: unknown[] = [];
    const seen = await seenWith((context) => async (sourceId) => void contexts.push([context.principal.id, sourceId]));
    await seen?.askSourceReadable?.('demo');
    expect(contexts).toEqual([['p-1', 'demo']]);
  });

  it('is absent when the application gives none', async () => {
    expect((await seenWith(undefined))?.askSourceReadable).toBeUndefined();
  });
});
