import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskPlan, AskPlanner, AuditEvent } from '@neburyx/contracts';
import { createEnterpriseExtension, type PlanStore } from '@neburyx/ee-ask';
import pino from 'pino';
import { stringify } from 'yaml';
import { z } from 'zod';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { routesWithoutPermission } from '../permissions.js';
import { communitySeams } from '../seams/community-seams.js';
import { start, type StartIo } from '../start.js';
import { baseSource } from '../testing/mapping.js';
import { memoryAppStore } from '../testing/app-store.js';
import { checkOperations } from '../testing/contract-check.js';
import { createListPlanStore } from '../testing/list-plan-store.js';
import { loadCommittedDocument } from '../testing/document.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'ee-ask-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const previewFile = join(folder, 'preview.yaml');
const COMPLETE_AI = { preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } };
writeFileSync(previewFile, stringify({ sources: [], ai: COMPLETE_AI }));
const incompleteFile = join(folder, 'incomplete.yaml');
writeFileSync(incompleteFile, stringify({ sources: [], ai: { preview: true, provider: 'anthropic', key: { env: 'AI_TEST_KEY' } } }));
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
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'present' }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, { preview: true }]);
    expect(registeredRoutesOf(result.app).find((route) => route.url === '/v1/ai/status')).toMatchObject({ method: 'GET', permission: 'principal' });
    expect(routesWithoutPermission(registeredRoutesOf(result.app))).toEqual([]);
    await result.app.close();
  });

  it('refuses a start with the real configuration unmet, naming the setting, and a key variable that is not set', async () => {
    const errors: string[] = [];
    const io = { ...startIo(), stderr: { write: (text: string) => errors.push(text) } };
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: incompleteFile, NEBURYX_PROFILE: 'enterprise' }, io)).toEqual({ exitCode: 1 });
    expect(errors).toEqual(['invalid configuration: ai.model is required when the AI preview is on\n', 'invalid configuration: ai.key.env: the variable AI_TEST_KEY is not set or is empty\n']);
  });

  describe('the property list of the real extension', () => {
    const SOURCE = baseSource({
      id: 'demo',
      entities: [{ type: 'person', label: 'Person', stable_id: 'id', search: ['name'], pii: [{ property: 'ssn', class: 'text' }] }],
      relationships: [],
    });
    const mappingWith = (name: string, ai: Record<string, unknown>): string => {
      const file = join(folder, `${name}.yaml`);
      writeFileSync(file, stringify({ sources: [SOURCE], ai: { ...COMPLETE_AI, ...ai } }));
      return file;
    };
    async function started(name: string, ai: Record<string, unknown>) {
      const errors: string[] = [];
      const lines: string[] = [];
      const io = { ...startIo(), stderr: { write: (text: string) => errors.push(text) }, logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }) };
      const result = await start({ DATABASE_URL, NEBURYX_CONFIG: mappingWith(name, ai), NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'present' }, io);
      return { result, errors, lines };
    }

    it.each([
      ['an unknown type', { properties: { company: ['name'] } }, 'invalid configuration: ai.properties: company is not an entity type or a relationship type of the mapping\n'],
      ['an unknown property', { properties: { person: ['nickname'] } }, 'invalid configuration: ai.properties.person: nickname is not a property the mapping names for it\n'],
      ['a pii property without the override', { properties: { person: ['ssn'] } }, 'invalid configuration: ai.properties.person: ssn is a pii property; naming it needs ai.pii_override: true\n'],
    ])('refuses %s with exit 1, naming the setting', async (name, ai, message) => {
      const { result, errors } = await started(`refuse-${name.replaceAll(' ', '-')}`, ai);
      expect(result).toEqual({ exitCode: 1 });
      expect(errors).toEqual([message]);
    });

    it('starts with a listed property, with no warning', async () => {
      const { result, lines } = await started('listed', { properties: { person: ['name'] } });
      expect(result.exitCode).toBe(0);
      expect(lines.filter((line) => line.includes('ai.pii_override'))).toEqual([]);
      if (result.exitCode === 0) await result.app.close();
    });

    it('starts with a pii property named and the override on, and warns naming type.property and no value', async () => {
      const { result, lines } = await started('override', { properties: { person: ['name', 'ssn'] }, pii_override: true });
      expect(result.exitCode).toBe(0);
      const warned = lines.filter((line) => line.includes('ai.pii_override'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('ai.properties.person: ssn is a pii property');
      if (result.exitCode === 0) await result.app.close();
    });
  });

  it.each([true, false])('is described by the committed contract when mounted with the preview on %s', async (previewOn) => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), extension: createEnterpriseExtension(), previewOn });
    const failures = await checkOperations(app, loadCommittedDocument(), {});
    expect(failures.filter((failure) => failure.route.includes('/v1/ai/status') || failure.route.includes('/v1/ask/'))).toEqual([]);
    await app.close();
  });

  it('answers POST /v1/ask/plan with 422 ASK_UNSUPPORTED, the reason not-in-this-edition and its sentence, while the extension has no planner (it is not configured)', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), extension: createEnterpriseExtension(), previewOn: true });
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/plan', payload: { message: 'Who shares a device?', sourceId: 'demo' } });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.message, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', 'Ask is not available in this edition.', { reason: 'not-in-this-edition' }]);
    await app.close();
  });

  it.each([['a missing body', undefined], ['no message', {}], ['an empty message', { message: '' }], ['another field', { message: 'x', send: true }]])('answers POST /v1/ask/plan with 400 INVALID_REQUEST for %s', async (_name, payload) => {
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'present' }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ method: 'POST', url: '/v1/ask/plan', ...(payload === undefined ? {} : { payload }) });
    expect([answer.statusCode, answer.json().error.code]).toEqual([400, 'INVALID_REQUEST']);
    await result.app.close();
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
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'present' }, { ...startIo(), extensionLoader: { load: async () => probe } });
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
    writeFileSync(aiFile, stringify({ sources: [], ai: { ...COMPLETE_AI, max_retries: 0 } }));
    try {
      const io = { ...startIo(), logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }), extensionLoader: { load: async () => extension } };
      const result = await start({ DATABASE_URL, NEBURYX_CONFIG: aiFile, NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'SENTINEL-KEY' }, io);
      expect(result.exitCode).toBe(0);
      if (result.exitCode !== 0) return;
      const answer = await extension.model()?.call({ promptId: 'summary.view', parameters: { view: 'SENTINEL-PROMPT' } }, { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1' }, new AbortController().signal);
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

describe('the Ask plan route with a planner installed through the seams', () => {
  const REF = { entityType: 'node_a', stableId: 'A-1' };
  const PLAN: AskPlan = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: REF, attributeType: 'attr_type', via: 'attr_link', limit: 25 }, rationale: 'People who share a device.' };

  async function appWith(answer: unknown) {
    const seen: string[] = [];
    const lines: string[] = [];
    // a planner that answers something that is not a plan is the case under test, and the type forbids it
    const planner: AskPlanner = { availability: () => ({ available: true }), plan: async ({ text }) => (seen.push(text), answer as never) };
    const app = await buildApp({ webRoot, logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }), store: memoryAppStore(), seams: { ...communitySeams(), askPlanner: planner }, extension: createEnterpriseExtension(), previewOn: true });
    return { app, seen, lines };
  }

  it('is described by the committed contract when the stub answers a plan', async () => {
    const { app } = await appWith(PLAN);
    const failures = await checkOperations(app, loadCommittedDocument(), {});
    expect(failures.filter((failure) => failure.route.includes('/v1/ask/plan'))).toEqual([]);
    await app.close();
  });
});

describe('the Ask run route', () => {
  const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';

  async function appOf(planner: AskPlanner | undefined, previewOn = true) {
    return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams: { ...communitySeams(), ...(planner === undefined ? {} : { askPlanner: planner }) }, extension: createEnterpriseExtension(), previewOn });
  }

  it('answers 422 ASK_UNSUPPORTED with the reason not-in-this-edition under the Community planner', async () => {
    const app = await appOf(undefined);
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: PLAN_ID } });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }]);
    await app.close();
  });

  it('answers 422 ASK_UNSUPPORTED before any read when the planner is available but the application has no plan store or no runner', async () => {
    const app = await appOf({ availability: () => ({ available: true }), plan: () => Promise.reject(new Error('must not be called')) });
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: PLAN_ID } });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }]);
    await app.close();
  });

  it('answers 422 ASK_UNSUPPORTED when there is a store but the application built no gate, so no runner', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams: { ...communitySeams(), askPlanner: { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('must not be called')) } }, extension: createEnterpriseExtension({ planStore: createListPlanStore() }), previewOn: true });
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: PLAN_ID } });
    expect([answer.statusCode, answer.json().error.code]).toEqual([422, 'ASK_UNSUPPORTED']);
    await app.close();
  });

  it.each([['a missing body', undefined], ['a plan ID that is not a uuid', { planId: 'plan-1' }], ['another field', { planId: PLAN_ID, send: true }]])('answers 400 INVALID_REQUEST for %s', async (_name, payload) => {
    const app = await appOf(undefined);
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/run', ...(payload === undefined ? {} : { payload }) });
    expect([answer.statusCode, answer.json().error.code]).toEqual([400, 'INVALID_REQUEST']);
    await app.close();
  });

  it.each([['/v1/ask/plan', { message: 'Who shares a device?' }], ['/v1/ask/run', { planId: PLAN_ID }], ['/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity', params: {} }], ['/v1/ask/cancel', { planId: PLAN_ID }]])('answers 403 ACCESS_DENIED with the reason ai-preview-off for %s when the preview is off, and never calls the planner', async (url, payload) => {
    const calls: string[] = [];
    const app = await appOf({ availability: () => (calls.push('availability'), { available: true }), plan: () => (calls.push('plan'), Promise.reject(new Error('must not be called'))) }, false);
    const answer = await app.inject({ method: 'POST', url, payload });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([403, 'ACCESS_DENIED', { reason: 'ai-preview-off' }]);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('answers 403 ACCESS_DENIED with one audited refusal, not 400, for a bad body when the preview is off', async () => {
    const events: AuditEvent[] = [];
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams: { ...communitySeams(), audit: { record: async (event) => void events.push(event) } }, extension: createEnterpriseExtension(), previewOn: false });
    const answer = await app.inject({ method: 'POST', url: '/v1/ask/plan', payload: { nothing: true } });
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([403, 'ACCESS_DENIED', { reason: 'ai-preview-off' }]);
    expect(events).toHaveLength(1);
    await app.close();
  });
});

describe('the Ask edit and cancel routes', () => {
  const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';
  const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('must not be called')) };
  const base = { id: PLAN_ID, userId: 'u', sourceId: 'demo', turnId: undefined, templateId: 'entity', templateVersion: 1, params: {}, parentPlanId: undefined, planningTraceId: 'tr', createdAt: new Date(), expiresAt: new Date() } as const;

  async function appOf(planner: AskPlanner | undefined, store?: PlanStore) {
    return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams: { ...communitySeams(), ...(planner === undefined ? {} : { askPlanner: planner }) }, extension: createEnterpriseExtension(store === undefined ? {} : { planStore: store }), previewOn: true });
  }
  const post = (app: Awaited<ReturnType<typeof appOf>>, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never });

  const BODIES = [['/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity', params: {} }], ['/v1/ask/cancel', { planId: PLAN_ID }]] as const;

  it.each(BODIES)('answers 422 ASK_UNSUPPORTED with the reason not-in-this-edition for %s under the Community planner', async (url, payload) => {
    const app = await appOf(undefined);
    const answer = await post(app, url, payload);
    expect([answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([422, 'ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }]);
    await app.close();
  });

  it.each(BODIES)('answers 422 ASK_UNSUPPORTED for %s when the store is not built', async (url, payload) => {
    const app = await appOf(available);
    const answer = await post(app, url, payload);
    expect([answer.statusCode, answer.json().error.code]).toEqual([422, 'ASK_UNSUPPORTED']);
    await app.close();
  });

  it.each([
    ['/v1/ask/edit', { planId: 'plan-1', templateId: 'entity', params: {} }],
    ['/v1/ask/edit', { planId: PLAN_ID, templateId: 'free-query', params: {} }],
    ['/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity' }],
    ['/v1/ask/cancel', { planId: 'plan-1' }],
    ['/v1/ask/cancel', { planId: PLAN_ID, extra: 1 }],
  ])('answers 400 INVALID_REQUEST for a malformed body of %s', async (url, payload) => {
    const app = await appOf(available, createListPlanStore());
    const answer = await post(app, url, payload);
    expect([answer.statusCode, answer.json().error.code]).toEqual([400, 'INVALID_REQUEST']);
    await app.close();
  });

  it('answers 404 NOT_FOUND for a plan the store does not hold', async () => {
    const app = await appOf(available, createListPlanStore());
    const answer = await post(app, '/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity', params: {} });
    expect([answer.statusCode, answer.json().error.code]).toEqual([404, 'NOT_FOUND']);
    await app.close();
  });

  it('answers 409 CONFLICT with the reason plan-not-runnable and its sentence for a plan that is no longer proposed', async () => {
    const store: PlanStore = { ...createListPlanStore(), get: async () => ({ ...base, state: 'confirmed' }), cancel: async () => ({ status: 'not-runnable' }) };
    const app = await appOf(available, store);
    for (const [url, payload] of [['/v1/ask/edit', { planId: PLAN_ID, templateId: 'entity', params: {} }], ['/v1/ask/cancel', { planId: PLAN_ID }]] as const) {
      const answer = await post(app, url, payload);
      expect([answer.statusCode, answer.json().error.code, answer.json().error.details, answer.json().error.message]).toEqual([409, 'CONFLICT', { reason: 'plan-not-runnable' }, 'This plan can no longer be run. Ask the question again to get a new plan.']);
    }
    await app.close();
  });

  it('answers 409 CONFLICT with the reason plan-expired for a plan that expired', async () => {
    const store: PlanStore = { ...createListPlanStore(), cancel: async () => ({ status: 'expired' }) };
    const app = await appOf(available, store);
    const answer = await post(app, '/v1/ask/cancel', { planId: PLAN_ID });
    expect([answer.statusCode, answer.json().error.details]).toEqual([409, { reason: 'plan-expired' }]);
    await app.close();
  });

  it('answers 200 with the plan cancelled for a cancel the store accepts', async () => {
    const store: PlanStore = { ...createListPlanStore(), cancel: async () => ({ status: 'cancelled' }) };
    const app = await appOf(available, store);
    const answer = await post(app, '/v1/ask/cancel', { planId: PLAN_ID });
    expect([answer.statusCode, answer.json()]).toEqual([200, { planId: PLAN_ID, state: 'cancelled' }]);
    await app.close();
  });

  it('answers 500 INTERNAL_ERROR, with no store detail, when the store fails', async () => {
    const store: PlanStore = { ...createListPlanStore(), cancel: async () => Promise.reject(new Error('relation "ask_plans" does not exist')) };
    const app = await appOf(available, store);
    const answer = await post(app, '/v1/ask/cancel', { planId: PLAN_ID });
    expect([answer.statusCode, answer.json().error.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(answer.body).not.toContain('ask_plans');
    await app.close();
  });
});
