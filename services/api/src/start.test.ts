import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppStore } from './app-store.js';
import type { ExecuteCall } from './gate/executor.js';
import { assembleGate } from './gate/assemble.js';
import { DEFAULT_BUDGETS } from './gate/budgets.js';
import { communitySeams } from './seams/community-seams.js';
import { createNeo4jExecutor } from './sources/executor.js';
import { fakeDrivers } from './testing/fake-source-driver.js';
import { mappingOf, sourceWith } from './testing/gate-fixtures.js';
import { TestExecutor } from './testing/gate.js';
import { fileOf } from './testing/mapping.js';
import { SERVER_ROW } from './testing/source-tester.js';
import { testSourceGate } from './testing/source-gate.js';
import { SourceGateError } from './gate/allowlist.js';
import type { SourceGate, SourceGateOptions } from './gate/source-gate.js';
import { start, type StartIo } from './start.js';
import { memoryAppStore, memoryStoreWith } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
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
      defaultWebRoot: webRoot,
      openStore: memoryAppStore,
      ...overrides,
    },
  };
}

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
      return { gate: unusedRunner, system: unusedRunner, close: () => (order.push('gate closed'), Promise.resolve()) };
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
        openSourceGate: (): SourceGate => ({ gate: parts.gate, system: parts.system, close: () => (closed.push('gate'), Promise.resolve()) }),
        portOverride: 0,
      } satisfies Partial<StartIo>,
    };
  }

  const down = (call: ExecuteCall) => Promise.resolve(call.sourceId === 'alpha' ? ({ status: 'unavailable', reason: 'unreachable' } as const) : ({ status: 'rows', rows: [SERVER_ROW] } as const));

  it('checks every source before the server listens, and starts although one is down', async () => {
    const parts = wired(new TestExecutor(down));
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
    await result.app.close();
  });

  it('runs no check for a mapping with no source', async () => {
    const parts = wired(new TestExecutor(down));
    const result = await start(DATABASE_ENV, io(parts.io).io);
    expect(result.exitCode).toBe(0);
    expect(parts.executor.calls).toEqual([]);
    if (result.exitCode === 0) await result.app.close();
  });

  it('stops with the message of a rule that names a problem, closing the gate and the store', async () => {
    const parts = wired(new TestExecutor(down));
    const run = io({ ...parts.io, startupProblem: (results) => (results.some((result) => result.outcome === 'fail') ? 'source alpha failed its check' : undefined) });
    const result = await start(ENV, run.io);
    expect(result.exitCode).toBe(1);
    expect(run.errors.join('')).toBe('source alpha failed its check\n');
    expect(parts.closed).toEqual(['gate', 'store']);
  });

  it('stops when the check cannot be stored, closing the gate and the store', async () => {
    const parts = wired(new TestExecutor(down));
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
