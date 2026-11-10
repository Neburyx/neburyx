import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { serve, type ShutdownTimes, type Signals } from './serve.js';
import { assembleGate } from './gate/assemble.js';
import type { SourceGate, SourceGateOptions } from './gate/source-gate.js';
import { communitySeams } from './seams/community-seams.js';
import { createNeo4jExecutor } from './sources/executor.js';
import { memoryAppStore } from './testing/app-store.js';
import { fakeDrivers } from './testing/fake-source-driver.js';
import { sourceWith } from './testing/gate-fixtures.js';
import { fileOf } from './testing/mapping.js';
import { SERVER_ROW } from './testing/source-tester.js';
import { makeWebRoot } from './testing/web-root.js';
import { makeExportDirectory } from './testing/export-directory.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const ENV = { DATABASE_URL: 'postgres://app@db.example.test/neburyx', NEBURYX_WEB_ROOT: webRoot };

function signals(): { readonly signals: Signals; readonly emitter: EventEmitter; readonly exits: number[] } {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return {
    emitter,
    exits,
    signals: {
      once: (signal, listener) => emitter.once(signal, listener),
      exit: (code) => {
        exits.push(code);
      },
    },
  };
}

const QUICK: ShutdownTimes = { graceMs: 100, deadlineMs: 2000 };

const io = (stderr: string[] = []): Parameters<typeof serve>[1] => ({
  stderr: { write: (text) => stderr.push(text) },
  logger: pino({ level: 'silent' }),
  defaultWebRoot: webRoot, defaultExportDirectory: exportDirectory,
  openStore: memoryAppStore,
  tasks: [],
  portOverride: 0,
});

describe('serve', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('closes the server and exits 0 on %s', async (signal) => {
    const run = signals();
    await serve(ENV, io(), run.signals);
    expect(run.exits).toEqual([]);
    run.emitter.emit(signal);
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
  });

  it('closes once when both signals arrive', async () => {
    const run = signals();
    await serve(ENV, io(), run.signals);
    run.emitter.emit('SIGTERM');
    run.emitter.emit('SIGINT');
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
  });

  it('exits with the start-up failure code and registers no signal handler when it cannot start', async () => {
    const run = signals();
    const errors: string[] = [];
    await serve({ ...ENV, NEBURYX_PORT: 'x' }, io(errors), run.signals);
    expect(run.exits).toEqual([1]);
    expect(run.emitter.listenerCount('SIGTERM')).toBe(0);
    expect(errors.join('')).toContain('NEBURYX_PORT');
  });

  it('drops a request that is still being answered after the grace period, then exits 0', async () => {
    const run = signals();
    const hanging = (): ReturnType<typeof memoryAppStore> => ({ ...memoryAppStore(), current: () => new Promise(() => undefined) });
    const started = await serve(ENV, { ...io(), openStore: hanging }, run.signals, QUICK);
    if (started.exitCode !== 0) throw new Error('the server did not start');
    const address = started.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('the server has no port');
    const socket = connect(address.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /v1/me HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(run.exits).toEqual([0]), { timeout: 1500 });
    socket.destroy();
  });

  it('gives up with exit 1 when closing never finishes', async () => {
    const run = signals();
    const stuck = (): ReturnType<typeof memoryAppStore> => ({ ...memoryAppStore(), close: () => new Promise<void>(() => undefined) });
    await serve(ENV, { ...io(), openStore: stuck }, run.signals, { graceMs: 50, deadlineMs: 200 });
    run.emitter.emit('SIGINT');
    await vi.waitFor(() => expect(run.exits).toEqual([1]), { timeout: 1500 });
  });
});

describe('serve while a ping is stuck', () => {
  const folder = mkdtempSync(join(tmpdir(), 'serve-ping-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'neburyx.yaml');
  writeFileSync(file, fileOf(sourceWith('alpha')));

  it('exits 0 within the deadline on SIGTERM', async () => {
    const fake = fakeDrivers({ rows: [SERVER_ROW] });
    const run = signals();
    const options: Parameters<typeof serve>[1] = {
      ...io(),
      pingIntervalMs: 20,
      openSourceGate: (gateOptions: SourceGateOptions): SourceGate => {
        const executor = createNeo4jExecutor({ sources: gateOptions.mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: gateOptions.logger, createDriver: fake.factory });
        const defaults = communitySeams();
        const parts = assembleGate({ mapping: gateOptions.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: gateOptions.logger });
        return { ...parts, close: () => executor.close() };
      },
    };
    await serve({ ...ENV, NEBURYX_CONFIG: file }, options, run.signals, QUICK);
    const before = fake.drivers[0]?.sessions.length ?? 0;
    fake.behaviour = { beginHang: true };
    await vi.waitFor(() => expect(fake.drivers[0]?.sessions.length ?? 0).toBeGreaterThan(before));
    const began = Date.now();
    run.emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
    expect(Date.now() - began).toBeLessThan(QUICK.deadlineMs);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(run.exits).toEqual([0]);
  });
});
