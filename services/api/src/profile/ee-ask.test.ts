import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import pino from 'pino';
import { stringify } from 'yaml';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { routesWithoutPermission } from '../permissions.js';
import { start, type StartIo } from '../start.js';
import { baseSource } from '../testing/mapping.js';
import { memoryAppStore } from '../testing/app-store.js';
import { checkOperations } from '../testing/contract-check.js';
import { loadCommittedDocument } from '../testing/document.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';

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
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', AI_TEST_KEY: 'present' }, { ...startIo(), extensionLoader: { load: async () => probe } });
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect((await result.app.inject({ url: '/v1/probe' })).statusCode).toBe(200);
    expect(seen).toEqual([true]);
    await result.app.close();
  });
});
