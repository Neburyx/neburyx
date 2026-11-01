import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { serve, type ShutdownTimes, type Signals } from './serve.js';
import { memoryAppStore } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
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
  defaultWebRoot: webRoot,
  openStore: memoryAppStore,
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
