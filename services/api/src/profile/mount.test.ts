import { rmSync } from 'node:fs';
import { ExtensionRefusal, type AuditEvent, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
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

async function started(extension: ProfileExtension, options: { readonly previewOn?: boolean; readonly record?: (event: AuditEvent) => Promise<void> } = {}) {
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
    ['a refusal with another code', () => ({ name: 'ExtensionRefusal', ...REFUSAL, code: 'NOT_FOUND' })],
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
