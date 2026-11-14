import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import pino from 'pino';
import { stringify } from 'yaml';
import { z } from 'zod';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { routesWithoutPermission } from '../permissions.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { start, type StartIo } from '../start.js';
import { memoryAppStore } from '../testing/app-store.js';
import { checkOperations } from '../testing/contract-check.js';
import { loadCommittedDocument } from '../testing/document.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { baseSource } from '../testing/mapping.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'ee-ask-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
  removeAskFolders();
});

const previewFile = join(folder, 'preview.yaml');
const PREVIEW_AI = { preview: true };
writeFileSync(previewFile, stringify({ sources: [], ai: PREVIEW_AI }));
const ASK_ENV = { NEBURYX_ASK_API_KEY: 'present', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder() };
const plainFile = join(folder, 'plain.yaml');
writeFileSync(plainFile, stringify({ sources: [] }));

const DATABASE_URL = 'postgres://app_user@db.example.test:5432/neburyx';
const startIo = (): StartIo => ({
  stderr: { write: () => true },
  logger: pino({ level: 'silent' }),
  defaultWebRoot: webRoot,
  defaultExportDirectory: exportDirectory,
  openStore: memoryAppStore,
  tasks: [],
  portOverride: 0,
  extensionLoader: { load: async () => createEnterpriseExtension() },
});

describe('the real enterprise extension in a start', () => {
  it('answers 404 and registers no route under /v1/ai when the switch is off', async () => {
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: plainFile }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect((await result.app.inject({ url: '/v1/ai/status' })).statusCode).toBe(404);
    expect(registeredRoutesOf(result.app).filter((route) => route.url.startsWith('/v1/ai'))).toEqual([]);
    await result.app.close();
  });

  it('answers 200 with the status and declares the principal permission when the switch is on', async () => {
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', ...ASK_ENV }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, { preview: true }]);
    expect(registeredRoutesOf(result.app).find((route) => route.url === '/v1/ai/status')).toMatchObject({ method: 'GET', permission: 'principal' });
    expect(routesWithoutPermission(registeredRoutesOf(result.app))).toEqual([]);
    await result.app.close();
  });

  it('refuses a start with the real configuration unmet, naming each variable that is missing', async () => {
    const errors: string[] = [];
    const io = { ...startIo(), stderr: { write: (text: string) => errors.push(text) } };
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' }, io)).toEqual({ exitCode: 1 });
    expect(errors).toEqual(['invalid configuration: NEBURYX_ASK_MAPPING_FOLDER is required when the AI preview is on\n', 'invalid configuration: NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE is required when the AI preview is on\n']);
  });

  it.each([
    ['prompts', { prompts: { 'ask.plan': '/etc/neburyx/prompts/ask-plan.txt' } }],
    ['properties', { properties: { person: ['name'] } }],
    ['pii_override', { pii_override: true }],
    ['model', { model: 'claude-sonnet-5-5' }],
    ['key', { key: { env: 'AI_TEST_KEY' } }],
  ])('refuses a start whose ai block still has the removed key %s, with exit 1', async (name, ai) => {
    const file = join(folder, `removed-${name}.yaml`);
    writeFileSync(file, stringify({ sources: [], ai: { ...PREVIEW_AI, ...ai } }));
    const errors: string[] = [];
    const io = { ...startIo(), stderr: { write: (text: string) => errors.push(text) } };
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: file, NEBURYX_PROFILE: 'enterprise', ...ASK_ENV }, io)).toEqual({ exitCode: 1 });
    expect(errors.join('')).toContain(name);
  });

  it('refuses a start whose Ask folder holds a query that writes, with exit 1, naming the file and the intent and holding no query text or secret', async () => {
    const file = join(folder, 'bad-folder.yaml');
    writeFileSync(file, stringify({ sources: [baseSource({ id: 'demo' })], ai: PREVIEW_AI }));
    const bad = makeAskFolder(['demo']);
    writeFileSync(join(bad, 'demo', 'intents.json'), JSON.stringify({ wipe: { parameters: [], query: "MATCH (n) WHERE n.x = 'SENTINEL_TEXT' DETACH DELETE n" } }));
    const errors: string[] = [];
    const io = { ...startIo(), stderr: { write: (text: string) => errors.push(text) } };
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: file, NEBURYX_PROFILE: 'enterprise', ...ASK_ENV, NEBURYX_ASK_API_KEY: 'SENTINEL-KEY', NEBURYX_ASK_MAPPING_FOLDER: bad }, io)).toEqual({ exitCode: 1 });
    const text = errors.join('');
    expect(text).toContain('NEBURYX_ASK_MAPPING_FOLDER/demo/intents.json: intent "wipe"');
    expect(text).not.toContain('SENTINEL');
  });

  it.each([true, false])('is described by the committed contract when mounted with the preview on %s', async (previewOn) => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), extension: createEnterpriseExtension(), previewOn });
    const failures = await checkOperations(app, loadCommittedDocument(), {});
    expect(failures.filter((failure) => failure.route.includes('/v1/ai/status'))).toEqual([]);
    await app.close();
  });

  it('answers the status route with the 403 of a refusal when the app is told the preview is off', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), extension: createEnterpriseExtension(), previewOn: false });
    const answer = await app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([403, 'ACCESS_DENIED', { reason: 'ai-preview-off' }]);
    await app.close();
  });
});

describe('what a start tells the routes of an extension', () => {
  it('tells them the preview is on when the switch is on', async () => {
    const seen: boolean[] = [];
    const probe = { name: 'probe', routeGroups: [{ routes: [{ method: 'GET' as const, url: '/v1/probe', permission: 'principal' as const, responseSchema: z.unknown(), handler: async (request: { readonly previewOn: boolean }) => (seen.push(request.previewOn), 'ok') }] }] };
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', ...ASK_ENV }, { ...startIo(), extensionLoader: { load: async () => probe } });
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect((await result.app.inject({ url: '/v1/probe' })).statusCode).toBe(200);
    expect(seen).toEqual([true]);
    await result.app.close();
  });
});

describe('a model failure in the real enterprise extension in a start', () => {
  it('reaches the API log as one warning in the API log shape, and nothing reaches the process output', async () => {
    const provider = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'SENTINEL-BODY' } }));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('the stub provider has no port');
    const lines: string[] = [];
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    const extension = createEnterpriseExtension({ modelBaseUrl: `http://127.0.0.1:${(address as AddressInfo).port}` });
    const aiFile = join(folder, 'failing.yaml');
    writeFileSync(aiFile, stringify({ sources: [], ai: PREVIEW_AI }));
    try {
      const io = { ...startIo(), logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }), extensionLoader: { load: async () => extension } };
      const result = await start({ DATABASE_URL, NEBURYX_CONFIG: aiFile, NEBURYX_PROFILE: 'enterprise', ...ASK_ENV, NEBURYX_ASK_API_KEY: 'SENTINEL-KEY', NEBURYX_ASK_MAX_RETRIES: '0' }, io);
      expect(result.exitCode).toBe(0);
      if (result.exitCode !== 0) return;
      const answer = await extension.model()?.call({ promptId: 'test.prompt', version: 1, instructions: 'SENTINEL-PROMPT', values: 'SENTINEL-VALUES' }, { action: 'ai.summary', actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1' }, new AbortController().signal);
      expect(answer).toMatchObject({ status: 'failed', code: 'provider-error' });
      const failures = lines.filter((line) => line.includes('ai.provider_failure'));
      expect(failures).toHaveLength(1);
      const parsed = JSON.parse(failures[0] ?? '{}') as Record<string, unknown>;
      expect(parsed).toMatchObject({ level: 40, event: 'ai.provider_failure', code: 'provider-error', msg: 'a model call failed' });
      expect(typeof parsed.time).toBe('number');
      expect(lines.join('')).not.toMatch(/SENTINEL/);
      expect(written).toEqual([]);
      await result.app.close();
    } finally {
      out.mockRestore();
      err.mockRestore();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});

describe('the removed Ask routes', () => {
  const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';
  const CALLS = [
    ['/v1/ask/plan', { message: 'Who shares a device?', sourceId: 'demo' }],
    ['/v1/ask/run', { planId: PLAN_ID }],
    ['/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity', params: {} }],
    ['/v1/ask/cancel', { planId: PLAN_ID }],
  ] as const;

  it.each([
    ['the Community profile', undefined],
    ['the enterprise profile with the preview on', true],
    ['the enterprise profile with the preview off', false],
  ])('answer 404 for every call, with nothing audited and no route registered, in %s', async (_name, previewOn) => {
    const events: AuditEvent[] = [];
    const seams: Seams = { ...communitySeams(), audit: { record: async (event) => void events.push(event) } };
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams, ...(previewOn === undefined ? {} : { extension: createEnterpriseExtension(), previewOn }) });
    for (const [url, payload] of CALLS) expect((await app.inject({ method: 'POST', url, payload })).statusCode, url).toBe(404);
    expect(registeredRoutesOf(app).filter((route) => route.url.startsWith('/v1/ask'))).toEqual([]);
    expect(events).toEqual([]);
    await app.close();
  });
});
