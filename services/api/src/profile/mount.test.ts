import { rmSync } from 'node:fs';
import { ExtensionRefusal, type AuditEvent, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
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

  it('gives the handler the parsed body and the application planner', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(postExtension(async (request) => ((seen = request), 'ok')), { previewOn: true });
    const answer = await app.inject({ method: 'POST', url: URL_OF_ROUTE, payload: { message: 'hello' } });
    expect(answer.statusCode).toBe(200);
    expect(seen).toMatchObject({ body: { message: 'hello' } });
    expect(seen?.askPlanner.availability()).toEqual({ available: false, reason: 'not_in_this_edition' });
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

describe('a refusal that no planner can answer', () => {
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


describe('what the mount gives an extension for previews of Ask', () => {
  it('gives a signing function, a policy version of none and no key bytes', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true });
    await app.inject({ url: URL_OF_ROUTE });
    expect(seen?.previewMac?.('a text')).toMatch(/^[0-9a-f]{64}$/);
    expect(seen?.policyVersionOf?.('any-source')).toBe('none');
    const values = Object.values(seen ?? {});
    expect(values.some((value) => value instanceof Uint8Array)).toBe(false);
    await app.close();
  });

  it('signs the same text the same way with the same key and differently with another key', async () => {
    const macOf = async (previewKey: Buffer) => {
      let seen: ExtensionRequest | undefined;
      const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true, app: { previewKey } });
      await app.inject({ url: URL_OF_ROUTE });
      await app.close();
      return seen?.previewMac?.('a text');
    };
    const first = await macOf(Buffer.alloc(32, 1));
    expect(await macOf(Buffer.alloc(32, 1))).toBe(first);
    expect(await macOf(Buffer.alloc(32, 2))).not.toBe(first);
  });

  it('answers the policy version the application and its gate use for the source', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true, app: { policyVersion: (sourceId) => `v-${sourceId}` } });
    await app.inject({ url: URL_OF_ROUTE });
    expect(seen?.policyVersionOf?.('demo')).toBe('v-demo');
    await app.close();
  });

  it('gives no search tools when the application has no gate', async () => {
    let seen: ExtensionRequest | undefined;
    const { app } = await started(extensionOf(async (request) => ((seen = request), 'ok')), { previewOn: true });
    await app.inject({ url: URL_OF_ROUTE });
    expect(seen?.askEntityTools).toBeUndefined();
    await app.close();
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
