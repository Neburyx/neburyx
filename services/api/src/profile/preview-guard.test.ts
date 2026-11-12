import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiStatusResponseSchema, type AuditEvent, type ProfileExtension } from '@neburyx/contracts';
import { ROUTE_REFUSED_ACTION, guardAiRouteGroup } from '@neburyx/ee-ask';
import pino from 'pino';
import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { start, type StartIo } from '../start.js';
import { memoryAppStore } from '../testing/app-store.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'preview-guard-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const PROBE_URL = '/v1/ai/probe';
const mappingOf = (source: Record<string, unknown>) => parseMapping(fileOf(baseSource(source)), 'neburyx.yaml');

function probeOf(calls: string[]): ProfileExtension {
  return { name: 'probe', routeGroups: [guardAiRouteGroup({ routes: [{ method: 'GET', url: PROBE_URL, permission: 'principal', responseSchema: aiStatusResponseSchema, handler: async () => (calls.push('provider'), { preview: true }) }] })] };
}

async function appOf(options: { readonly previewOn: boolean; readonly source: Record<string, unknown> }) {
  const calls: string[] = [];
  const events: AuditEvent[] = [];
  const seams: Seams = { ...communitySeams(), audit: { record: async (event) => void events.push(event) } };
  const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams, mapping: mappingOf(options.source), extension: probeOf(calls), previewOn: options.previewOn });
  return { app, calls, events };
}

describe('a call to an AI route with the preview on', () => {
  it.each([
    ['a source that is not synthetic', { id: 'real-source' }],
    ['a synthetic source', { id: 'demo-source', synthetic: true }],
  ])('passes the hook and reaches the handler once, under a mapping that holds only %s', async (_name, source) => {
    const { app, calls, events } = await appOf({ previewOn: true, source });
    const answer = await app.inject({ url: PROBE_URL });
    expect([answer.statusCode, answer.json()]).toEqual([200, { preview: true }]);
    expect(calls).toEqual(['provider']);
    expect(events).toEqual([]);
    await app.close();
  });
});

describe('a call to an AI route of a loaded extension whose preview is reported off', () => {
  it('answers 403 ACCESS_DENIED with the reason, never reaches the handler and records one refusal event', async () => {
    const { app, calls, events } = await appOf({ previewOn: false, source: { id: 'real-source' } });
    const answer = await app.inject({ url: PROBE_URL });
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error).toMatchObject({ code: 'ACCESS_DENIED', retryable: false, details: { reason: 'ai-preview-off' }, traceId: answer.headers['x-trace-id'] });
    expect(calls).toEqual([]);
    expect(events).toHaveLength(1);
    await app.close();
  });

  it('records an event that holds the fixed keys only: no value, no source, no request text', async () => {
    const { app, events } = await appOf({ previewOn: false, source: { id: 'real-source' } });
    await app.inject({ url: `${PROBE_URL}?question=who+is+Jane+Doe&source=real-source` });
    const [event] = events;
    expect(Object.keys(event ?? {}).sort()).toEqual(['action', 'actorId', 'actorRole', 'result', 'traceId']);
    expect([event?.action, event?.result]).toEqual([ROUTE_REFUSED_ACTION, 'refused']);
    expect(JSON.stringify(event)).not.toMatch(/real-source|Jane|question/);
    await app.close();
  });
});

describe('a Community start', () => {
  const DATABASE_URL = 'postgres://app_user@db.example.test:5432/neburyx';
  const plainFile = join(folder, 'plain.yaml');
  writeFileSync(plainFile, stringify({ sources: [] }));

  it('answers an AI path with the unknown-route 404 and registers none under /v1/ai', async () => {
    const io: StartIo = {
      stderr: { write: () => true },
      logger: pino({ level: 'silent' }),
      defaultWebRoot: webRoot,
      defaultExportDirectory: exportDirectory,
      openStore: memoryAppStore,
      tasks: [],
      portOverride: 0,
      extensionLoader: { load: async () => probeOf([]) },
    };
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: plainFile }, io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ url: PROBE_URL });
    expect(answer.statusCode).toBe(404);
    expect(registeredRoutesOf(result.app).filter((route) => route.url.startsWith('/v1/ai'))).toEqual([]);
    await result.app.close();
  });

  it('records no audit event of any kind for a call to an AI path, since no extension is loaded', async () => {
    const events: AuditEvent[] = [];
    const seams: Seams = { ...communitySeams(), audit: { record: async (event) => void events.push(event) } };
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams, mapping: mappingOf({ id: 'real-source' }) });
    expect((await app.inject({ url: PROBE_URL })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/ai/status' })).statusCode).toBe(404);
    expect(events).toEqual([]);
    await app.close();
  });
});
