import { defaultCatalog } from './gate/default-catalog.js';
import { seamsOf } from './app.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pino from 'pino';
import { stringify } from 'yaml';
import { z } from 'zod';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppStore } from './app-store.js';
import type { ExecuteCall, ExecuteOutcome } from './gate/executor.js';
import { assembleGate } from './gate/assemble.js';
import { DEFAULT_BUDGETS } from './gate/budgets.js';
import { communitySeams } from './seams/community-seams.js';
import { createNeo4jExecutor } from './sources/executor.js';
import { fakeDrivers } from './testing/fake-source-driver.js';
import { mappingOf, sourceWith } from './testing/gate-fixtures.js';
import { TestExecutor } from './testing/gate.js';
import { fileOf } from './testing/mapping.js';
import { fittingSchemaAnswer, SERVER_ROW, serverExecutor } from './testing/source-tester.js';
import { testSourceGate } from './testing/source-gate.js';
import { SourceGateError } from './gate/allowlist.js';
import type { CursorCodec } from './gate/cursor/codec.js';
import { createSourceGate, type SourceGate, type SourceGateOptions } from './gate/source-gate.js';
import { READINESS_LIMIT_MS } from './health/readiness.js';
import { SHUTDOWN_TIMES } from './serve.js';
import { createSourceTester } from './source-test/tester.js';
import { start, type StartIo } from './start.js';
import { registeredRoutesOf } from './app.js';
import { routesWithoutPermission } from './permissions.js';
import { clearRegisteredExtension, EXTENSION_CONFIGURE_FAILED_MESSAGE, EXTENSION_LOAD_FAILED_MESSAGE, NO_EXTENSION_MESSAGE, type ExtensionLoader } from './profile/extension.js';
import type { ExtensionRoute, ProfileExtension } from '@neburyx/contracts';
import { LOCAL_IDENTITY, memoryAppStore, memoryStoreWith } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';
import { makeExportDirectory } from './testing/export-directory.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const emptyRoot = mkdtempSync(join(tmpdir(), 'empty-root-'));
const directoryIndexRoot = mkdtempSync(join(tmpdir(), 'directory-index-'));
mkdirSync(join(directoryIndexRoot, 'index.html'));
const unreadableIndexRoot = mkdtempSync(join(tmpdir(), 'unreadable-index-'));
writeFileSync(join(unreadableIndexRoot, 'index.html'), '<title>x</title>');
chmodSync(join(unreadableIndexRoot, 'index.html'), 0o000);
afterAll(() => {
  chmodSync(join(unreadableIndexRoot, 'index.html'), 0o600);
  for (const folder of [webRoot, emptyRoot, directoryIndexRoot, unreadableIndexRoot]) {
    rmSync(folder, { recursive: true, force: true });
  }
});

const DATABASE_ENV = { DATABASE_URL: 'postgres://app_user@db.example.test:5432/neburyx' };

const logLineSchema = z.object({ event: z.string().optional(), msg: z.string() });

function io(overrides: Partial<StartIo> = {}): { readonly io: StartIo; readonly errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    io: {
      stderr: { write: (text) => errors.push(text) },
      logger: pino({ level: 'silent' }),
      defaultWebRoot: webRoot, defaultExportDirectory: exportDirectory,
      openStore: memoryAppStore,
      tasks: [],
      ...overrides,
    },
  };
}

describe('the maintenance tasks at start', () => {
  const runnerSeen = () => {
    const seen: { tasks: readonly { name: string; schedule?: string }[] }[] = [];
    const startJobRunner: NonNullable<StartIo['startJobRunner']> = (_url, tasks) => {
      seen.push({ tasks: tasks.map((task) => ({ name: task.name, ...(task.schedule === undefined ? {} : { schedule: task.schedule }) })) });
      return Promise.resolve(undefined);
    };
    return { seen, startJobRunner };
  };

  it('hands the runner the two purges and the export expiry with their daily schedules when no task list is injected', async () => {
    const { seen, startJobRunner } = runnerSeen();
    const run = io({ startJobRunner });
    delete (run.io as { tasks?: unknown }).tasks;
    const result = await start(DATABASE_ENV, run.io);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([{ tasks: [{ name: 'purge-deleted-investigations', schedule: '17 3 * * *' }, { name: 'purge-deleted-patterns', schedule: '29 3 * * *' }, { name: 'expire-exports', schedule: '41 3 * * *' }] }]);
    if ('app' in result) await result.app.close();
  });

  it('hands the runner an injected list as it is, and builds no shipped task', async () => {
    const { seen, startJobRunner } = runnerSeen();
    const run = io({ startJobRunner, tasks: [{ name: 'mine', run: () => Promise.resolve() }] });
    const result = await start(DATABASE_ENV, run.io);
    expect(seen).toEqual([{ tasks: [{ name: 'mine' }] }]);
    if ('app' in result) await result.app.close();
  });
});

describe('the preview switch at start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'preview-switch-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  function mappingFile(name: string, ai: unknown): string {
    const file = join(folder, `${name}.yaml`);
    writeFileSync(file, stringify({ sources: [], ...(ai === undefined ? {} : { ai }) }));
    return file;
  }

  async function started(profile: string | undefined, ai: unknown, name: string) {
    const run = io({ portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: mappingFile(name, ai), ...(profile === undefined ? {} : { NEBURYX_PROFILE: profile }) }, run.io);
    return { run, result };
  }

  it('starts as before with no profile and no ai section', async () => {
    const { run, result } = await started(undefined, undefined, 'none');
    expect(result.exitCode).toBe(0);
    expect(run.errors).toEqual([]);
    if (result.exitCode === 0) await result.app.close();
  });

  it('refuses the enterprise profile without ai.preview, naming both and listening on nothing', async () => {
    const { run, result } = await started('enterprise', undefined, 'profile-only');
    expect(result).toEqual({ exitCode: 1 });
    expect(run.errors.join('')).toBe('invalid configuration: NEBURYX_PROFILE=enterprise is set but ai.preview: true is not set in the mapping file; set both or neither\n');
  });

  it('refuses ai.preview without the enterprise profile, naming both and listening on nothing', async () => {
    const { run, result } = await started(undefined, { preview: true }, 'preview-only');
    expect(result).toEqual({ exitCode: 1 });
    expect(run.errors.join('')).toBe('invalid configuration: ai.preview: true is set in the mapping file but NEBURYX_PROFILE=enterprise is not set; set both or neither\n');
  });

  it('refuses an unknown profile value naming the key and not the value', async () => {
    const { run, result } = await started('preview', undefined, 'bad-profile');
    expect(result).toEqual({ exitCode: 1 });
    expect(run.errors.join('')).toBe('invalid configuration: NEBURYX_PROFILE\n');
  });

  it('refuses an ai section with a key it does not have through the mapping diagnostics', async () => {
    const { run, result } = await started(undefined, { properties: ['x'] }, 'bad-ai');
    expect(result).toEqual({ exitCode: 1 });
    expect(run.errors.join('')).toContain('ai');
  });
});

describe('the enterprise extension at start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'extension-start-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const previewFile = join(folder, 'preview.yaml');
  writeFileSync(previewFile, stringify({ sources: [], ai: { preview: true } }));
  const offFile = join(folder, 'off.yaml');
  writeFileSync(offFile, stringify({ sources: [] }));

  const statusSchema = z.strictObject({ ok: z.literal(true) });
  const route = (overrides: Partial<ExtensionRoute> = {}): ExtensionRoute => ({
    method: 'GET',
    url: '/v1/fake/status',
    permission: 'principal',
    responseSchema: statusSchema,
    handler: async () => ({ ok: true }),
    ...overrides,
  });
  const extensionWith = (...routes: ExtensionRoute[]): ProfileExtension => ({ name: 'fake', routeGroups: [{ routes }] });
  const ON = { ...DATABASE_ENV, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' };
  const OFF = { ...DATABASE_ENV, NEBURYX_CONFIG: offFile };

  function run(extension: () => Promise<ProfileExtension>) {
    const lines: string[] = [];
    const calls = { loads: 0 };
    const loader: ExtensionLoader = { load: () => (calls.loads++, extension()) };
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    return { ...io({ portOverride: 0, logger, extensionLoader: loader }), lines, calls };
  }

  it('never calls the loader and mounts nothing when the switch is off', async () => {
    const rig = run(async () => extensionWith(route()));
    const result = await start(OFF, rig.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(rig.calls.loads).toBe(0);
    expect((await result.app.inject({ url: '/v1/fake/status' })).statusCode).toBe(404);
    expect(registeredRoutesOf(result.app).some((entry) => entry.url.startsWith('/v1/fake'))).toBe(false);
    expect(rig.lines.some((line) => line.includes('profile.extension_loaded'))).toBe(false);
    expect((await result.app.inject({ url: '/v1/me' })).json()).toMatchObject({ edition: 'community' });
    await result.app.close();
  });

  it('loads the extension and serves its route with the declared permission when the switch is on', async () => {
    const rig = run(async () => extensionWith(route()));
    const result = await start(ON, rig.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(rig.calls.loads).toBe(1);
    const answer = await result.app.inject({ url: '/v1/fake/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, { ok: true }]);
    expect(registeredRoutesOf(result.app).find((entry) => entry.url === '/v1/fake/status')).toMatchObject({ method: 'GET', permission: 'principal' });
    expect(routesWithoutPermission(registeredRoutesOf(result.app))).toEqual([]);
    expect(rig.lines.filter((line) => line.includes('profile.extension_loaded'))).toHaveLength(1);
    expect((await result.app.inject({ url: '/v1/me' })).json()).toMatchObject({ edition: 'enterprise' });
    await result.app.close();
  });

  it('exits 1 when the switch is on and the build has no enterprise code, listening on nothing', async () => {
    clearRegisteredExtension();
    const rig = io({ portOverride: 0 });
    expect(await start(ON, rig.io)).toEqual({ exitCode: 1 });
    expect(rig.errors.join('')).toBe(`${NO_EXTENSION_MESSAGE}\n`);
  });

  it('exits 1 without the cause of a loader that fails, listening on nothing', async () => {
    const rig = run(async () => {
      throw new Error('cannot find /secret/place/extension.js');
    });
    expect(await start(ON, rig.io)).toEqual({ exitCode: 1 });
    expect(rig.errors.join('')).toBe(`${EXTENSION_LOAD_FAILED_MESSAGE}\n`);
  });

  it.each([['a missing permission', undefined], ['an unknown permission', 'admin']])('exits 1 naming the route that has %s', async (_name, permission) => {
    const rig = run(async () => extensionWith(route({ permission: permission as never })));
    expect(await start(ON, rig.io)).toEqual({ exitCode: 1 });
    expect(rig.errors.join('')).toBe('the enterprise route GET /v1/fake/status has no known permission\n');
  });

  it.each(['/', '/healthz', '/readyz', '/v1', '/fake/status'])('exits 1 naming a route at %s, which is outside /v1/', async (url) => {
    const rig = run(async () => extensionWith(route({ url })));
    expect(await start(ON, rig.io)).toEqual({ exitCode: 1 });
    expect(rig.errors.join('')).toBe(`the enterprise route GET ${url} is outside /v1/\n`);
  });

  it('logs the code of a loader failure and nothing else of it', async () => {
    const rig = run(async () => {
      throw Object.assign(new Error('cannot find /secret/place/extension.js'), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    expect(await start(ON, rig.io)).toEqual({ exitCode: 1 });
    const failed = rig.lines.filter((line) => line.includes('profile.extension_load_failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('ERR_MODULE_NOT_FOUND');
    expect(rig.lines.join('')).not.toContain('/secret/place');
  });

  it('answers INTERNAL_ERROR, and logs no body, when a reply does not match its schema', async () => {
    const rig = run(async () => extensionWith(route({ handler: async () => ({ ok: false, secret: 'SENTINEL-VALUE' }) })));
    const result = await start(ON, rig.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ url: '/v1/fake/status' });
    expect(answer.statusCode).toBe(500);
    expect(answer.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(answer.body).not.toContain('SENTINEL-VALUE');
    expect(rig.lines.join('')).not.toContain('SENTINEL-VALUE');
    await result.app.close();
  });

  describe('configuring the extension', () => {
    const aiFile = join(folder, 'ai.yaml');
    const AI = { preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } };
    writeFileSync(aiFile, stringify({ sources: [], ai: AI }));
    const CONFIGURED = { ...DATABASE_ENV, NEBURYX_CONFIG: aiFile, NEBURYX_PROFILE: 'enterprise' };

    function configuring(configure: NonNullable<ProfileExtension['configure']>) {
      const events: string[] = [];
      const calls: { settings: unknown; env: unknown; view: unknown }[] = [];
      const extension: ProfileExtension = { ...extensionWith(route()), configure: async (settings, env, view) => (events.push('configure'), calls.push({ settings, env, view }), configure(settings, env, view)) };
      const lines: string[] = [];
      const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
      const base = io({ portOverride: 0, logger, extensionLoader: { load: async () => extension } });
      const opened: StartIo['openStore'] = () => (events.push('open-store'), memoryAppStore());
      return { ...base, io: { ...base.io, openStore: opened }, events, calls, lines };
    }

    it('calls configure once, with the settings and the environment, before the store is opened', async () => {
      const rig = configuring(async () => ({ ok: true }));
      const result = await start(CONFIGURED, rig.io);
      expect(result.exitCode).toBe(0);
      expect(rig.events).toEqual(['configure', 'open-store']);
      expect(rig.calls).toEqual([{ settings: AI, env: CONFIGURED, view: { types: [] } }]);
      if (result.exitCode === 0) await result.app.close();
    });

    it('logs each warning of a successful configure at warn level with its event name, and goes on', async () => {
      const rig = configuring(async () => ({ ok: true, warnings: [{ event: 'ai.pii_override', message: 'ai.properties.person: ssn is a pii property that may be sent to the model' }] }));
      const result = await start(CONFIGURED, rig.io);
      expect(result.exitCode).toBe(0);
      const warned = rig.lines.filter((line) => line.includes('ai.pii_override'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('"level":40');
      expect(warned[0]).toContain('ssn is a pii property');
      if (result.exitCode === 0) await result.app.close();
    });

    it('logs nothing of the kind when there are no warnings', async () => {
      const rig = configuring(async () => ({ ok: true }));
      const result = await start(CONFIGURED, rig.io);
      expect(rig.lines.filter((line) => line.includes('ai.pii_override'))).toEqual([]);
      if (result.exitCode === 0) await result.app.close();
    });

    it('writes every problem on a line of its own and exits 1 without opening the store', async () => {
      const rig = configuring(async () => ({ ok: false, problems: ['ai.model is required when the AI preview is on', 'ai.key.env: the variable AI_TEST_KEY is not set or is empty'] }));
      expect(await start(CONFIGURED, rig.io)).toEqual({ exitCode: 1 });
      expect(rig.errors.join('')).toBe('invalid configuration: ai.model is required when the AI preview is on\ninvalid configuration: ai.key.env: the variable AI_TEST_KEY is not set or is empty\n');
      expect(rig.events).toEqual(['configure']);
    });

    it('exits 1 with a fixed message, naming no error, path or file content, when configure throws', async () => {
      const rig = configuring(async () => {
        throw Object.assign(new Error('EACCES: /secret/place/prompt.txt SENTINEL-CONTENT'), { code: 'EACCES' });
      });
      expect(await start(CONFIGURED, rig.io)).toEqual({ exitCode: 1 });
      expect(rig.errors.join('')).toBe(`${EXTENSION_CONFIGURE_FAILED_MESSAGE}\n`);
      expect(rig.events).toEqual(['configure']);
      const failed = rig.lines.filter((line) => line.includes('profile.extension_configure_failed'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('EACCES');
      expect(rig.lines.join('')).not.toContain('SENTINEL-CONTENT');
    });

    it('never loads the extension or calls configure when the switch is off, whatever ai keys the file has', async () => {
      const offWithKeys = join(folder, 'off-with-keys.yaml');
      writeFileSync(offWithKeys, stringify({ sources: [], ai: { provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } } }));
      const rig = configuring(async () => ({ ok: true }));
      const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: offWithKeys }, rig.io);
      expect(result.exitCode).toBe(0);
      expect(rig.events).toEqual(['open-store']);
      if (result.exitCode === 0) await result.app.close();
    });
  });
});

describe('start-up failures from the task list', () => {
  const noop = (): Promise<void> => Promise.resolve();

  it('exits 1 naming a task that is registered twice, before touching the database', async () => {
    const run = io({ tasks: [{ name: 'purge', run: noop }, { name: 'purge', run: noop }] });
    const result = await start({ ...DATABASE_ENV }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('invalid configuration: task purge registered twice\n');
  });

  it('exits 1 naming a task whose schedule is not a cron expression', async () => {
    const run = io({ tasks: [{ name: 'expire', run: noop, schedule: 'sometimes' }] });
    const result = await start({ ...DATABASE_ENV }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('invalid configuration: task expire has a schedule that is not a valid cron expression\n');
  });
});

describe('start-up failures', () => {
  it('exits 1 naming DATABASE_URL when it is not set', async () => {
    const run = io();
    const result = await start({}, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('invalid configuration: DATABASE_URL\n');
  });

  it.each([
    ['a folder that does not exist', join(tmpdir(), 'no-such-folder-for-web-root')],
    ['a folder without index.html', emptyRoot],
    ['a folder whose index.html is a directory', directoryIndexRoot],
    ['a folder whose index.html cannot be read', unreadableIndexRoot],
  ])('exits 1 for %s, naming the key and not the value', async (_name, folder) => {
    const run = io();
    const result = await start({ ...DATABASE_ENV, NEBURYX_WEB_ROOT: folder }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toContain('NEBURYX_WEB_ROOT');
    expect(run.errors.join('')).not.toContain(folder);
  });

  it.each([
    ['NEBURYX_PORT', '0'],
    ['NEBURYX_PORT', '65536'],
    ['NEBURYX_PORT', 'abc'],
    ['NEBURYX_PORT', '8080x'],
    ['NEBURYX_HOST', ''],
    ['NEBURYX_HOST', 'bad host'],
    ['NEBURYX_HOST', '999.1.1.1'],
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'mysql://app:secret-word@db.example.test/neburyx'],
    ['DATABASE_URL', 'postgres://app:%FF@db.example.test/neburyx'],
    ['DATABASE_URL', 'postgres://%FF/neburyx'],
  ])('exits 1 for %s=%j, naming the key and not the value', async (key, value) => {
    const run = io();
    const result = await start({ ...DATABASE_ENV, [key]: value }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toContain(key);
    if (value.length > 0) expect(run.errors.join('')).not.toContain(value);
  });
});

describe('start-up that cannot listen', () => {
  it('exits 1 naming NEBURYX_PORT when the port is in use, without the number', async () => {
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    const address = taken.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const run = io();
    const result = await start({ ...DATABASE_ENV, NEBURYX_PORT: String(port) }, run.io);
    taken.close();
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toContain('NEBURYX_PORT');
    expect(run.errors.join('')).not.toContain(String(port));
  });

  it('never throws for a scoped IPv6 host and never prints its value', async () => {
    const run = io({ portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_HOST: 'fe80::1%lo0' }, run.io);
    if (result.exitCode === 0) await result.app.close();
    expect(run.errors.join('')).not.toContain('fe80');
  });

  it('exits 1 naming NEBURYX_HOST when the address is not this machine’s, without the value', async () => {
    const run = io({ portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_HOST: '192.0.2.1' }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toContain('NEBURYX_HOST');
    expect(run.errors.join('')).not.toContain('192.0.2.1');
  });
});

describe('start-up', () => {
  it('listens on the loopback address by default', async () => {
    const run = io({ portOverride: 0 });
    const result = await start({ ...DATABASE_ENV }, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const address = result.app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    await result.app.close();
  });

  it('serves a web folder given as a relative path', async () => {
    const run = io({ defaultWebRoot: emptyRoot, portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_WEB_ROOT: relative(process.cwd(), webRoot) }, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const response = await result.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    await result.app.close();
  });

  it('serves the configured web folder', async () => {
    const run = io({ defaultWebRoot: emptyRoot, portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_WEB_ROOT: webRoot }, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const response = await result.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    await result.app.close();
  });
});

describe('exposure warning at start-up', () => {
  function captured(): { readonly lines: string[]; readonly run: StartIo } {
    const lines: string[] = [];
    const { io: run } = io({
      logger: pino({ level: 'info' }, { write: (chunk: string) => lines.push(chunk) }),
      portOverride: 0,
      fileExists: () => false,
    });
    return { lines, run };
  }

  it('writes the warning once, before the server starts listening', async () => {
    const { lines, run } = captured();
    const result = await start({ ...DATABASE_ENV, NEBURYX_HOST: '0.0.0.0' }, run);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    await result.app.inject({ method: 'GET', url: '/' });
    await result.app.inject({ method: 'GET', url: '/' });
    const events = lines.map((line) => logLineSchema.parse(JSON.parse(line)));
    const warned = events.findIndex((line) => line.event === 'server.exposed');
    const listening = events.findIndex((line) => line.msg.startsWith('Server listening'));
    expect(events.filter((line) => line.event === 'server.exposed')).toHaveLength(1);
    expect(warned).toBeGreaterThanOrEqual(0);
    expect(warned).toBeLessThan(listening);
    await result.app.close();
  });

  it('writes no warning on the default loopback host', async () => {
    const { lines, run } = captured();
    const result = await start({ ...DATABASE_ENV }, run);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(lines.join('')).not.toContain('server.exposed');
    await result.app.close();
  });

  it('writes no warning inside a container', async () => {
    const { lines, run } = captured();
    const result = await start({ ...DATABASE_ENV, NEBURYX_HOST: '0.0.0.0', NEBURYX_CONTAINER: 'true' }, run);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(lines.join('')).not.toContain('server.exposed');
    await result.app.close();
  });
});

describe('the source gate at start-up', () => {
  const unusedRunner = { run: () => Promise.reject(new Error('not used')) };

  function tracked(order: string[]) {
    const opened: SourceGateOptions[] = [];
    const openSourceGate = (options: SourceGateOptions): SourceGate => {
      opened.push(options);
      return { gate: { run: unusedRunner.run, runMany: () => Promise.reject(new Error('not used')) }, system: unusedRunner, indexes: { read: () => Promise.reject(new Error('not used')) }, catalog: defaultCatalog(), close: () => (order.push('gate closed'), Promise.resolve()) };
    };
    const openStore = (): AppStore => {
      const store = memoryAppStore();
      return { ...store, close: () => (order.push('store closed'), store.close()) };
    };
    return { opened, openSourceGate, openStore };
  }

  it('builds the gate once from the mapping, the environment and the Community seams, and closes it before the store when the app closes', async () => {
    const order: string[] = [];
    const parts = tracked(order);
    const run = io({ portOverride: 0, openSourceGate: parts.openSourceGate, openStore: parts.openStore });
    const result = await start({ ...DATABASE_ENV }, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(parts.opened).toHaveLength(1);
    expect(parts.opened[0]).toMatchObject({ mapping: { sources: [] }, env: DATABASE_ENV });
    await result.app.close();
    expect(order).toEqual(['gate closed', 'store closed']);
  });

  it('builds the gate with the read slots as its coordinator, the same the app holds, so every read of the running server waits for a slot', async () => {
    const parts = tracked([]);
    const run = io({ portOverride: 0, openSourceGate: parts.openSourceGate, openStore: parts.openStore });
    const result = await start({ ...DATABASE_ENV }, run.io);
    if (result.exitCode !== 0) throw new Error('the server did not start');
    const coordinator = parts.opened[0]?.seams.coordinator;
    expect(seamsOf(result.app).coordinator).toBe(coordinator);
    const request = { principal: LOCAL_IDENTITY.principal, sourceId: 'demo', limits: { userConcurrency: 1, sourceConcurrency: 1, queueWaitMs: 20 }, role: 'data' as const, leaseTtlMs: 60_000 };
    const first = await coordinator?.acquireRead(request);
    await expect(coordinator?.acquireRead(request)).resolves.toEqual({ status: 'busy' });
    if (first?.status === 'granted') await first.lease.release();
    await result.app.close();
  });

  it('closes the gate when the start fails after it was built', async () => {
    const order: string[] = [];
    const parts = tracked(order);
    const run = io({ portOverride: 0, openSourceGate: parts.openSourceGate, openStore: parts.openStore });
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const result = await start({ ...DATABASE_ENV }, { ...run.io, portOverride: port });
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(result.exitCode).toBe(1);
    expect(parts.opened).toHaveLength(1);
    expect(order.filter((entry) => entry === 'gate closed')).toEqual(['gate closed']);
    expect(order.indexOf('gate closed')).toBeLessThan(order.indexOf('store closed'));
  });

  it('stops the start with the message of a label the gate cannot quote', async () => {
    const run = io({
      openSourceGate: () => {
        throw new SourceGateError('alpha', 'label of entity type person', 'x', 'holds a backtick, a backslash or a control character');
      },
    });
    const result = await start({ ...DATABASE_ENV }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toContain('source alpha: the label of entity type person');
  });
});

describe('the startup check in start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'startup-check-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha'), sourceWith('beta')));
  const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
  const ENV = { ...DATABASE_ENV, NEBURYX_CONFIG: file };

  function wired(executor: TestExecutor) {
    const store = memoryAppStore();
    const closed: string[] = [];
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const parts = testSourceGate(mapping, { executor });
    return {
      store,
      closed,
      lines,
      executor,
      io: {
        logger,
        openStore: () => ({ ...store, close: () => (closed.push('store'), store.close()) }),
        openSourceGate: (): SourceGate => ({ gate: parts.gate, system: parts.system, indexes: parts.indexes, catalog: parts.catalog, close: () => (closed.push('gate'), Promise.resolve()) }),
        portOverride: 0,
      } satisfies Partial<StartIo>,
    };
  }

  const LONG_INTERVAL_MS = 60 * 60 * 1000;
  const PERSON: ExecuteOutcome = { status: 'rows', rows: [{ n: { $type: 'node', elementId: '4:fixture:1', labels: ['Person'], properties: { id: 'P-1' } } }] };
  const readPerson = (app: { inject: (request: { method: 'GET'; url: string }) => Promise<{ statusCode: number }> }) => app.inject({ method: 'GET', url: '/v1/entities/alpha/person/P-1' });
  const alphaReads = (executor: TestExecutor): string[] => executor.calls.filter((call) => call.sourceId === 'alpha' && (call.templateId === 'schema-indexes' || call.templateId === 'entity-load')).map((call) => call.templateId);

  /** A source that is down at the start, and answers once `up.on` is set; its entity read finds one person. */
  function lateSource(schema: (call: ExecuteCall) => ExecuteOutcome = fittingSchemaAnswer, hold?: Promise<void>, pingIntervalMs = 20) {
    const up = { on: false };
    const executor = serverExecutor(
      async (call) => {
        if (call.sourceId === 'alpha' && !up.on) return { status: 'unavailable', reason: 'unreachable' } as const;
        if (hold !== undefined && up.on && call.templateId === 'capabilities') await hold;
        return call.templateId === 'entity-load' ? PERSON : ({ status: 'rows', rows: [SERVER_ROW] } as const);
      },
      undefined,
      schema,
    );
    const parts = wired(executor);
    const run = io({ ...parts.io, pingIntervalMs });
    return { up, parts, run };
  }

  const down = (call: ExecuteCall) => Promise.resolve(call.sourceId === 'alpha' ? ({ status: 'unavailable', reason: 'unreachable' } as const) : ({ status: 'rows', rows: [SERVER_ROW] } as const));

  it('checks every source before the server listens, and starts although one is down', async () => {
    const parts = wired(serverExecutor(down));
    const run = io(parts.io);
    const result = await start(ENV, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const events = parts.lines.map((line) => logLineSchema.parse(JSON.parse(line)));
    const checks = events.filter((line) => line.event === 'source.startup_check');
    const listening = events.findIndex((line) => line.msg.startsWith('Server listening'));
    expect(checks).toHaveLength(2);
    expect(events.findLastIndex((line) => line.event === 'source.startup_check')).toBeLessThan(listening);
    expect(parts.store.checks.map((check) => [check.report.sourceId, check.report.state, check.triggeredBy])).toEqual([['alpha', 'unavailable', null], ['beta', 'connected', null]]);
    expect((await parts.store.listSources()).map((row) => row.state)).toEqual(['unavailable', 'connected']);
    const ready = await result.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().sources).toEqual({ reachable: 1, unreachable: 1, unknown: 0 });
    await result.app.close();
  });

  describe('with a mapping that does not fit a source', () => {
    const noTokens = (call: ExecuteCall): ExecuteOutcome => (call.sourceId === 'alpha' && call.templateId === 'schema-tokens' ? { status: 'rows', rows: [{ labels: [], types: [] }] } : fittingSchemaAnswer(call));

    it('stops before the server listens with exit 1, one line for each failing finding that names the source, and the reports already stored', async () => {
      const parts = wired(serverExecutor(undefined, undefined, noTokens));
      const run = io(parts.io);
      const result = await start(ENV, run.io);
      expect(result.exitCode).toBe(1);
      const lines = run.errors.join('').split('\n');
      expect(lines.slice(0, 3)).toEqual([
        'source alpha: Entity type "person" (label "Person"): no node carries the label',
        'source alpha: Entity type "order_line" (label "Order Line"): no node carries the label',
        'source alpha: Relationship type "KNOWS" from "person" to "person": no relationship of the type exists',
      ]);
      expect(lines.at(-2)).toBe('Fix the source, then run test-source or test it from the Sources page.');
      expect(run.errors.join('')).not.toContain('beta');
      expect(parts.store.checks.map((check) => [check.report.sourceId, check.report.outcome, check.report.state])).toEqual([['alpha', 'fail', 'unavailable'], ['beta', 'pass', 'connected']]);
      expect(parts.lines.map((line) => logLineSchema.parse(JSON.parse(line))).some((line) => line.msg.startsWith('Server listening'))).toBe(false);
      expect(parts.closed).toEqual(['gate', 'store']);
    });

    it('goes on for a warning, for checks that could not be verified, and for a source that is down', async () => {
      for (const answer of [
        (call: ExecuteCall): ExecuteOutcome => (call.templateId === 'schema-indexes' ? { status: 'unavailable', reason: 'refused' } : fittingSchemaAnswer(call)),
        (call: ExecuteCall): ExecuteOutcome => (call.templateId === 'schema-indexes' ? { status: 'rows', rows: [{ indexes: [], truncated: true }] } : fittingSchemaAnswer(call)),
      ]) {
        const parts = wired(serverExecutor(undefined, undefined, answer));
        const result = await start(ENV, io(parts.io).io);
        expect(result.exitCode).toBe(0);
        expect(parts.store.checks.map((check) => check.report.mappingChecks.status)).toEqual(['not-verified', 'not-verified']);
        if (result.exitCode === 0) await result.app.close();
      }
      const parts = wired(serverExecutor(down));
      const result = await start(ENV, io(parts.io).io);
      expect(result.exitCode).toBe(0);
      if (result.exitCode === 0) await result.app.close();
    });

    it('reads a source that was down at the start once it answers, before any check has reached it: unchecked is usable, and the read is guarded by its indexes', async () => {
      const { up, parts, run } = lateSource(fittingSchemaAnswer, undefined, LONG_INTERVAL_MS);
      const result = await start(ENV, run.io);
      if (result.exitCode !== 0) throw new Error('the API did not start');
      up.on = true;
      const response = await readPerson(result.app);
      expect(response.statusCode).toBe(200);
      expect(alphaReads(parts.executor)).toEqual(['schema-indexes', 'entity-load']);
      expect(parts.store.checks.filter((check) => check.report.sourceId === 'alpha' && check.report.server !== null)).toEqual([]);
      await result.app.close();
    });

    describe('first contact', () => {

      it('checks a source that was down at the start when it first answers, and stores the state of the report', async () => {
        const { up, parts, run } = lateSource();
        const result = await start(ENV, run.io);
        expect(result.exitCode).toBe(0);
        if (result.exitCode !== 0) return;
        up.on = true;
        await vi.waitFor(async () => expect((await parts.store.listSources())[0]).toMatchObject({ id: 'alpha', state: 'connected' }), { timeout: 5000, interval: 20 });
        expect(parts.store.checks.filter((check) => check.report.sourceId === 'alpha' && check.report.server !== null)).toHaveLength(1);
        await result.app.close();
      });

      it('leaves a source with a wrong mapping unavailable with the reason, does not check it again, and still reads it: a finding refuses no read by itself', async () => {
        const wrong = (call: ExecuteCall): ExecuteOutcome => (call.sourceId === 'alpha' && call.templateId === 'schema-tokens' ? { status: 'rows', rows: [{ labels: [], types: [] }] } : fittingSchemaAnswer(call));
        const { up, parts, run } = lateSource(wrong);
        const result = await start(ENV, run.io);
        if (result.exitCode !== 0) throw new Error('the API did not start');
        up.on = true;
        await vi.waitFor(async () => expect((await parts.store.listSources())[0]).toMatchObject({ id: 'alpha', state: 'unavailable', stateReason: expect.stringMatching(/^The mapping does not fit the source: /) }), { timeout: 5000, interval: 20 });
        const checks = parts.store.checks.length;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(parts.store.checks).toHaveLength(checks);
        expect((await readPerson(result.app)).statusCode).toBe(200);
        expect(alphaReads(parts.executor).slice(-2)).toEqual(['schema-indexes', 'entity-load']);
        // the ping that follows keeps the state of that check: it reached the source and matches the source's connection and mapping
        expect((await parts.store.listSources())[0]).toMatchObject({ state: 'unavailable' });
        await result.app.close();
      });

      it('follows a passing check that another process stored, within one ping interval', async () => {
        const wrong = (call: ExecuteCall): ExecuteOutcome => (call.sourceId === 'alpha' && call.templateId === 'schema-tokens' ? { status: 'rows', rows: [{ labels: [], types: [] }] } : fittingSchemaAnswer(call));
        const { up, parts, run } = lateSource(wrong);
        const result = await start(ENV, run.io);
        if (result.exitCode !== 0) throw new Error('the API did not start');
        up.on = true;
        await vi.waitFor(async () => expect((await parts.store.listSources())[0]?.stateReason).toMatch(/^The mapping does not fit the source: /), { timeout: 5000, interval: 20 });
        // the command, in its own process, finds the mapping fixed and stores its report in the same database
        const { gate } = testSourceGate(mapping, { executor: serverExecutor() });
        const tester = createSourceTester({ gate, mapping, store: parts.store });
        await tester.run({ traceId: 'tr-command', principal: (await parts.store.current()).principal, sourceId: 'alpha' });
        await vi.waitFor(async () => expect((await parts.store.listSources())[0]).toMatchObject({ id: 'alpha', state: 'connected' }), { timeout: 5000, interval: 20 });
        await result.app.close();
      });

      it('waits for a check that is running when the API is closed, and starts no other', async () => {
        let release: (() => void) | undefined;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const { up, parts, run } = lateSource(fittingSchemaAnswer, hold);
        const result = await start(ENV, run.io);
        if (result.exitCode !== 0) throw new Error('the API did not start');
        up.on = true;
        await vi.waitFor(() => expect(parts.executor.calls.filter((call) => call.sourceId === 'alpha' && call.templateId === 'capabilities').length).toBeGreaterThan(1), { timeout: 5000, interval: 20 });
        let closed = false;
        const closing = result.app.close().then(() => (closed = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(closed).toBe(false);
        expect(parts.closed).toEqual([]);
        release?.();
        await closing;
        expect(parts.closed).toEqual(['gate', 'store']);
        const calls = parts.executor.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(parts.executor.calls).toHaveLength(calls);
      });
    });

    it('holds no address, credential or query text in the message, and shows a reachable source with a wrong mapping as reachable', async () => {
      const parts = wired(serverExecutor(undefined, undefined, noTokens));
      const run = io(parts.io);
      await start(ENV, run.io);
      expect(run.errors.join('')).not.toMatch(/graph\.example\.test|DEMO_|MATCH|CALL |password/i);
    });
  });

  it('runs no check for a mapping with no source', async () => {
    const parts = wired(serverExecutor(down));
    const result = await start(DATABASE_ENV, io(parts.io).io);
    expect(result.exitCode).toBe(0);
    expect(parts.executor.calls).toEqual([]);
    if (result.exitCode === 0) await result.app.close();
  });

  it('stops with the message of a rule that names a problem, closing the gate and the store', async () => {
    const parts = wired(serverExecutor(down));
    const run = io({ ...parts.io, startupProblem: (results) => (results.some((result) => result.outcome === 'fail') ? 'source alpha failed its check' : undefined) });
    const result = await start(ENV, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('source alpha failed its check\n');
    expect(parts.closed).toEqual(['gate', 'store']);
  });

  it('stops when the check cannot be stored, closing the gate and the store', async () => {
    const parts = wired(serverExecutor(down));
    const failing = memoryStoreWith({ failRecording: true });
    const run = io({ ...parts.io, openStore: () => ({ ...failing, close: () => (parts.closed.push('store'), failing.close()) }) });
    const result = await start(ENV, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('start-up failed\n');
    expect(parts.closed).toEqual(['gate', 'store']);
  });
});

describe('the startup check against sources that never answer', () => {
  const folder = mkdtempSync(join(tmpdir(), 'startup-hang-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha'), sourceWith('beta')));

  it('starts within one gate deadline, with exit 0, and stores both sources as not answering in time', async () => {
    const store = memoryAppStore();
    const fake = fakeDrivers({ beginHang: true });
    const run = io({
      portOverride: 0,
      openStore: () => store,
      openSourceGate: (options: SourceGateOptions): SourceGate => {
        const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: options.logger, createDriver: fake.factory });
        const defaults = communitySeams();
        const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
        return { ...parts, close: () => executor.close() };
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const started = start({ ...DATABASE_ENV, NEBURYX_CONFIG: file }, run.io);
      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGETS.requestTimeoutMs);
      vi.useRealTimers();
      const result = await started;
      expect(result.exitCode).toBe(0);
      expect(store.checks.map((check) => [check.report.sourceId, check.report.state, check.report.stateReason])).toEqual([
        ['alpha', 'unavailable', 'The source did not answer in time.'],
        ['beta', 'unavailable', 'The source did not answer in time.'],
      ]);
      if (result.exitCode === 0) await result.app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the startup check against sources whose privileges read never answers', () => {
  const folder = mkdtempSync(join(tmpdir(), 'startup-privileges-hang-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha'), sourceWith('beta')));

  it('starts within two gate deadlines, with exit 0, and stores both sources as connected with read-only not verified', async () => {
    const store = memoryAppStore();
    const fake = fakeDrivers({ rows: [SERVER_ROW], privilegesHang: true });
    const run = io({
      portOverride: 0,
      openStore: () => store,
      openSourceGate: (options: SourceGateOptions): SourceGate => {
        const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: options.logger, createDriver: fake.factory });
        const defaults = communitySeams();
        const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
        return { ...parts, close: () => executor.close() };
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const started = start({ ...DATABASE_ENV, NEBURYX_CONFIG: file }, run.io);
      // the capabilities reads answer at once; the privileges reads run to the deadline of their own request
      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGETS.requestTimeoutMs * 2);
      vi.useRealTimers();
      const result = await started;
      expect(result.exitCode).toBe(0);
      expect(store.checks.map((check) => [check.report.sourceId, check.report.state, check.report.readOnlyCheck, check.report.loginCanWrite])).toEqual([
        ['alpha', 'connected', 'not-verified', null],
        ['beta', 'connected', 'not-verified', null],
      ]);
      if (result.exitCode === 0) await result.app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the ping timer in start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ping-timer-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha'), sourceWith('beta')));
  const ENV = { ...DATABASE_ENV, NEBURYX_CONFIG: file };
  const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
  const pings = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'connectivity');

  function wired(executor: TestExecutor) {
    const parts = testSourceGate(mapping, { executor });
    return { openSourceGate: (): SourceGate => ({ gate: parts.gate, system: parts.system, indexes: parts.indexes, catalog: parts.catalog, close: () => Promise.resolve() }) };
  }

  it('pings every source on each tick after the server listens, and /readyz follows the answers', async () => {
    let answers = true;
    const executor = serverExecutor((call) => (call.templateId === 'connectivity' && !answers ? { status: 'unavailable', reason: 'unreachable' } : { status: 'rows', rows: [SERVER_ROW] }));
    const run = io({ ...wired(executor), portOverride: 0, pingIntervalMs: 20 });
    const result = await start(ENV, run.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const ready = async () => (await result.app.inject({ method: 'GET', url: '/readyz' })).json().sources;
    expect(await ready()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 });
    await vi.waitFor(() => expect(pings(executor).length).toBeGreaterThanOrEqual(4));
    answers = false;
    await vi.waitFor(async () => expect(await ready()).toEqual({ reachable: 0, unreachable: 2, unknown: 0 }));
    answers = true;
    await vi.waitFor(async () => expect(await ready()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 }));
    await result.app.close();
  });

  it('writes the ping outcome line of each source once, also when the state write fails', async () => {
    const executor = serverExecutor((call) => (call.templateId === 'connectivity' ? { status: 'unavailable', reason: 'authentication' } : { status: 'rows', rows: [SERVER_ROW] }));
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const store = memoryAppStore();
    const run = io({ ...wired(executor), logger, openStore: () => ({ ...store, applyPingState: () => Promise.reject(new Error('the state could not be written')) }), portOverride: 0, pingIntervalMs: 20 });
    const result = await start(ENV, run.io);
    if (result.exitCode !== 0) throw new Error('the API did not start');
    await vi.waitFor(() => expect(pings(executor).length).toBeGreaterThanOrEqual(6));
    await result.app.close();
    const events = lines.map((line) => logLineSchema.parse(JSON.parse(line))).filter((line) => line.event === 'source.ping_outcome' || line.event === 'source.ping_state_failed');
    const outcomes = lines.map((line) => JSON.parse(line)).filter((line) => line.event === 'source.ping_outcome');
    expect(outcomes.map((line) => [line.sourceId, line.outcome, line.failure]).sort()).toEqual([['alpha', 'unreachable', 'authentication'], ['beta', 'unreachable', 'authentication']]);
    expect(events.some((line) => line.event === 'source.ping_state_failed')).toBe(true);
  });

  it('starts no ping and no timer when the start fails, and none after the app closed', async () => {
    const executor = serverExecutor();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const failed = await start(ENV, { ...io({ ...wired(executor), pingIntervalMs: 20 }).io, portOverride: port });
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(failed.exitCode).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const started = await start(ENV, { ...io({ ...wired(executor), pingIntervalMs: 20 }).io, portOverride: 0 });
    if (started.exitCode !== 0) throw new Error('the API did not start');
    await vi.waitFor(() => expect(pings(executor).length).toBeGreaterThanOrEqual(2));
    await started.app.close();
    const after = pings(executor).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pings(executor).length).toBe(after);
  });
});

describe('closing while a ping is stuck', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ping-stuck-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha')));

  it('returns within the shutdown grace of the process, with no new run and the timer cleared', async () => {
    const fake = fakeDrivers({ rows: [SERVER_ROW] });
    const run = io({
      portOverride: 0,
      pingIntervalMs: 20,
      openSourceGate: (options: SourceGateOptions): SourceGate => {
        const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: options.logger, createDriver: fake.factory });
        const defaults = communitySeams();
        const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
        return { ...parts, close: () => executor.close() };
      },
    });
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: file }, run.io);
    if (result.exitCode !== 0) throw new Error('the API did not start');
    const before = fake.drivers[0]?.sessions.length ?? 0;
    fake.behaviour = { beginHang: true };
    await vi.waitFor(() => expect(fake.drivers[0]?.sessions.length ?? 0).toBeGreaterThan(before));
    const began = Date.now();
    await result.app.close();
    expect(Date.now() - began).toBeLessThan(SHUTDOWN_TIMES.graceMs);
    const sessions = fake.drivers[0]?.sessions.length ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.drivers[0]?.sessions.length).toBe(sessions);
  });
});

describe('the startup check when the schema is behind', () => {
  const folder = mkdtempSync(join(tmpdir(), 'startup-behind-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha')));
  const mapping = mappingOf(sourceWith('alpha'));

  it.each(['42P01', '42703'])('exits 1 with the migrate message when storing the check fails with %s', async (code) => {
    const parts = testSourceGate(mapping, { executor: serverExecutor() });
    const failing = { ...memoryAppStore(), recordSourceCheck: () => Promise.reject(Object.assign(new Error('relation or column is missing'), { code })) };
    const run = io({ openStore: () => failing, openSourceGate: (): SourceGate => ({ gate: parts.gate, system: parts.system, indexes: parts.indexes, catalog: parts.catalog, close: () => Promise.resolve() }), portOverride: 0 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: file }, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('the database schema is behind this version; run neburyx migrate\n');
  });
});

describe('the ping timer while the gate cannot grant a read', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ping-held-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha'), sourceWith('beta')));
  const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));

  it('answers /readyz from the cache with the counts of the start while pings are held, and keeps them when the pings end busy', async () => {
    let mode: 'grant' | 'hang' | 'busy' = 'grant';
    const coordinator = {
      acquireRead: () => (mode === 'hang' ? new Promise<never>(() => undefined) : Promise.resolve(mode === 'busy' ? ({ status: 'busy' } as const) : ({ status: 'granted', lease: { release: () => Promise.resolve() } } as const))),
    };
    const executor = serverExecutor();
    const parts = testSourceGate(mapping, { executor, seams: { ...communitySeams(), coordinator } });
    const run = io({ openSourceGate: (): SourceGate => ({ gate: parts.gate, system: parts.system, indexes: parts.indexes, catalog: parts.catalog, close: () => Promise.resolve() }), portOverride: 0, pingIntervalMs: 20 });
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: file }, run.io);
    if (result.exitCode !== 0) throw new Error('the API did not start');
    const ready = async () => {
      const began = Date.now();
      const response = await result.app.inject({ method: 'GET', url: '/readyz' });
      expect(Date.now() - began).toBeLessThan(READINESS_LIMIT_MS);
      return response.json().sources;
    };
    expect(await ready()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 });
    const pinged = () => executor.calls.filter((call) => call.templateId === 'connectivity').length;
    await vi.waitFor(() => expect(pinged()).toBeGreaterThanOrEqual(2));
    mode = 'busy';
    await new Promise((resolve) => setTimeout(resolve, 60));
    const whileBusy = pinged();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await ready()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 });
    expect(pinged()).toBe(whileBusy);
    mode = 'hang';
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await ready()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 });
    expect(pinged()).toBe(whileBusy);
    await result.app.close();
  });
});

describe('the cursor key at start', () => {
  const MARKER = 'MARKER-KEY-0123456789-ABCDEFGHIJ';
  const KEY = Buffer.from(MARKER, 'utf8').toString('base64');
  const binding = { source: null, principal: 'p', policyVersion: 'none', filterHash: 'f', sort: '', target: 'route', targetVersion: '1' };

  function recorded() {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const cursors: (CursorCodec | undefined)[] = [];
    const run = io({ logger, openSourceGate: (options) => (cursors.push(options.cursors), createSourceGate(options)) });
    return { ...run, lines, cursors };
  }

  it('warns once, naming the variable and holding no key, when it is not set, and the API still starts', async () => {
    const { io: run, lines, cursors } = recorded();
    const result = await start({ ...DATABASE_ENV }, { ...run, portOverride: 0 });
    expect(result.exitCode).toBe(0);
    const warnings = lines.filter((line) => line.includes('cursor.key_not_set'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NEBURYX_CURSOR_KEY');
    expect(cursors[0]).toBeDefined();
    if (result.exitCode === 0) await result.app.close();
  });

  it('does not warn when the key is set, and holds the key in no log line, no error and no readiness or health answer', async () => {
    const { io: run, lines, errors } = recorded();
    const result = await start({ ...DATABASE_ENV, NEBURYX_CURSOR_KEY: KEY }, { ...run, portOverride: 0 });
    expect(result.exitCode).toBe(0);
    expect(lines.some((line) => line.includes('cursor.key_not_set'))).toBe(false);
    if (result.exitCode === 0) {
      const answers = await Promise.all(['/healthz', '/readyz'].map((url) => result.app.inject({ method: 'GET', url })));
      for (const text of [...lines, ...errors, ...answers.map((answer) => answer.body)]) for (const secret of [MARKER, KEY, KEY.replace(/=+$/, '')]) expect(text).not.toContain(secret);
      await result.app.close();
    }
  });

  it('gives two API copies that share the key cursors that each can read, and a restart without a key cursors the earlier process cannot', async () => {
    const shared = recorded();
    const first = await start({ ...DATABASE_ENV, NEBURYX_CURSOR_KEY: KEY }, { ...shared.io, portOverride: 0 });
    const second = await start({ ...DATABASE_ENV, NEBURYX_CURSOR_KEY: KEY }, { ...shared.io, portOverride: 0 });
    const [one, two] = shared.cursors;
    expect(two?.verify(one?.mint(binding, { n: 1 }) ?? '', binding)).toEqual({ n: 1 });
    for (const result of [first, second]) if (result.exitCode === 0) await result.app.close();

    const loose = recorded();
    const before = await start({ ...DATABASE_ENV }, { ...loose.io, portOverride: 0 });
    const after = await start({ ...DATABASE_ENV }, { ...loose.io, portOverride: 0 });
    const [earlier, later] = loose.cursors;
    expect(() => later?.verify(earlier?.mint(binding, { n: 1 }) ?? '', binding)).toThrowError(expect.objectContaining({ code: 'CURSOR_INVALIDATED' }));
    for (const result of [before, after]) if (result.exitCode === 0) await result.app.close();
  });

  it.each([[''], ['too short'], [Buffer.alloc(31, 1).toString('base64')]])('stops the start, naming only the variable, for the key %j', async (value) => {
    const { io: run, errors, lines } = recorded();
    const result = await start({ ...DATABASE_ENV, NEBURYX_CURSOR_KEY: value }, run);
    expect(result.exitCode).toBe(1);
    expect(errors.join('')).toBe('invalid configuration: NEBURYX_CURSOR_KEY\n');
    if (value.length > 0) expect([...errors, ...lines].join('')).not.toContain(value);
  });
});

