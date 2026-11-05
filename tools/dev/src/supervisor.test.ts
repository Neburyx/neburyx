import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_READY_TIMEOUT_MS, supervise, type ApiSpec, type ChildSpec } from './supervisor.js';
import { settle } from './testing/settle.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'testing');
const folders: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(condition: () => boolean, ms = 10_000, describeState: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met; ${describeState()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Scene {
  readonly messages: string[];
  readonly stop: () => void;
  readonly done: Promise<number>;
  readonly watched: string;
  readonly lines: (prefix: string) => string[];
  readonly apiLines: () => string[];
  readonly pidOf: (line: string | undefined) => number;
  readonly waitFor: (condition: () => boolean) => Promise<void>;
}

async function scene(apiEnv: Record<string, string>, options: { readyTimeoutMs?: number; childEnv?: Record<string, string>; stopGraceMs?: number; apiPort?: number; onPids?: (pids: readonly number[]) => void } = {}): Promise<Scene> {
  const folder = mkdtempSync(join(tmpdir(), 'dev-supervisor-'));
  folders.push(folder);
  const log = join(folder, 'log.txt');
  const watched = join(folder, 'dist');
  mkdirSync(watched);
  writeFileSync(log, '');
  await settle(watched);
  const port = options.apiPort ?? (await freePort());
  const base = { PATH: process.env['PATH'] ?? '', LOG_FILE: log };
  const api: ApiSpec = {
    name: 'the API',
    command: process.execPath,
    args: [join(fixtures, 'api-fixture.mjs')],
    cwd: folder,
    env: { ...base, PORT: String(port), ...apiEnv },
    healthUrl: `http://127.0.0.1:${port}/healthz`,
    watch: [watched],
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
    debounceMs: 100,
  };
  const child: ChildSpec = { name: 'a compiler', command: process.execPath, args: [join(fixtures, 'child-fixture.mjs')], cwd: folder, env: { ...base, NAME: 'compiler', ...options.childEnv } };
  const messages: string[] = [];
  let stop: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const lines = (prefix: string): string[] => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith(prefix));
  const done = supervise({ children: [child], api, out: (text) => void messages.push(text), stopRequested, stopGraceMs: options.stopGraceMs ?? 300, ...(options.onPids === undefined ? {} : { onPids: options.onPids }) });
  cleanups.push(async () => {
    stop();
    await done.catch(() => undefined);
    for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const pid = Number(line.split(' ')[1]);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  return {
    messages,
    stop,
    done,
    watched,
    lines,
    apiLines: () => lines('start'),
    pidOf: (line) => Number(line?.split(' ')[1]),
    waitFor: (condition) => waitUntil(condition, 10_000, () => `messages: ${messages.join(' | ')}`),
  };
}

describe('the API supervisor', () => {
  it('uses a startup limit of seven gate deadlines of 10 s plus 50 s', () => {
    expect(API_READY_TIMEOUT_MS).toBe(120_000);
  });

  it('waits for an API that becomes ready after a delay shorter than the limit, and stops everything with exit 0 when asked', async () => {
    const run = await scene({ START_DELAY_MS: '1200' });
    await run.waitFor(() => run.messages.includes('the API is ready'));
    run.stop();
    expect(await run.done).toBe(0);
    expect(alive(run.pidOf(run.apiLines()[0]))).toBe(false);
  }, 30_000);

  it('still sees the API become ready when every socket refuses its type-of-service option, which would end the command if the readiness probe used the built-in fetch', async () => {
    const refused: Error[] = [];
    const onUncaught = (error: Error): void => void refused.push(error);
    process.on('uncaughtException', onUncaught);
    vi.spyOn(Socket.prototype, 'setTypeOfService').mockImplementation(() => {
      throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
    });
    try {
      const run = await scene({ START_DELAY_MS: '300' });
      await run.waitFor(() => run.messages.includes('the API is ready'));
      run.stop();
      expect(await run.done).toBe(0);
      expect(refused).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 30_000);

  it('stops every child and exits 1 naming the API when it does not become ready within the limit', async () => {
    const run = await scene({ NEVER_LISTEN: '1' }, { readyTimeoutMs: 1500 });
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
    expect(alive(run.pidOf(run.lines('compiler')[0]))).toBe(false);
  }, 30_000);

  it('still exits 1 for an API that never becomes ready when a file changes during its first start (the compiler writing its output)', async () => {
    const run = await scene({ NEVER_LISTEN: '1' }, { readyTimeoutMs: 2500 });
    await run.waitFor(() => run.apiLines().length === 1);
    writeFileSync(join(run.watched, 'main.js'), 'first output');
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
    expect(run.messages.join('\n')).not.toContain('after the change');
  }, 30_000);

  it('restarts an API that is still starting when a watched file changes, and waits for the new one instead of failing (the compiler writing its first output), even when a helper of the old one keeps its group alive for a moment', async () => {
    const run = await scene({ START_DELAY_MS: '1500', LINGERING_HELPER: '1' }, { readyTimeoutMs: 6000, stopGraceMs: 600 });
    await run.waitFor(() => run.apiLines().length === 1 && run.lines('helper').length === 1);
    const firstPid = run.pidOf(run.apiLines()[0]);
    writeFileSync(join(run.watched, 'main.js'), 'first output');
    await run.waitFor(() => run.apiLines().length === 2);
    await run.waitFor(() => run.messages.includes('the API is ready'));
    expect(alive(firstPid)).toBe(false);
    expect(run.messages.join('\n')).not.toContain('did not become ready');
    expect(await Promise.race([run.done, new Promise((resolve) => setTimeout(() => resolve('still running'), 300))])).toBe('still running');
    run.stop();
    expect(await run.done).toBe(0);
  }, 30_000);

  it('survives several changes during the first start and ends with one ready API', async () => {
    const run = await scene({ START_DELAY_MS: '1200', LINGERING_HELPER: '1' }, { readyTimeoutMs: 6000, stopGraceMs: 400 });
    await run.waitFor(() => run.apiLines().length === 1 && run.lines('helper').length === 1);
    for (const [index, name] of ['a.js', 'b.js', 'c.js'].entries()) {
      writeFileSync(join(run.watched, name), name);
      await run.waitFor(() => run.apiLines().length === index + 2);
    }
    await run.waitFor(() => run.messages[run.messages.length - 1] === 'the API is ready');
    expect(run.messages.join('\n')).not.toContain('did not become ready');
    const pids = run.apiLines().map((line) => run.pidOf(line));
    expect(pids).toHaveLength(4);
    expect(pids.slice(0, -1).some((pid) => alive(pid))).toBe(false);
    expect(alive(pids[3] ?? 0)).toBe(true);
    run.stop();
    expect(await run.done).toBe(0);
  }, 30_000);

  it('exits 1 at once when the API fails to start', async () => {
    const started = Date.now();
    const run = await scene({ FAIL_AT_START: '1' });
    expect(await run.done).toBe(1);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
  }, 30_000);

  it('does not call an API ready because something else answered on its port after the API itself had exited', async () => {
    const port = await freePort();
    const stub = createHttpServer((_request, response) => {
      setTimeout(() => response.end('ok'), 700);
    });
    await new Promise<void>((resolve) => stub.listen(port, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => void stub.close(() => resolve())));
    const run = await scene({ FAIL_AT_START: '1' }, { apiPort: port, readyTimeoutMs: 5000 });
    expect(await run.done).toBe(1);
    expect(run.messages).not.toContain('the API is ready');
  }, 30_000);

  it('tells an API that exits by itself after it was ready from a startup failure: it waits for the next change and restarts then', async () => {
    const run = await scene({ EXIT_AFTER_MS: '700' });
    await run.waitFor(() => run.messages.some((message) => message.includes('exited by itself (exit code 3)')));
    expect(run.apiLines()).toHaveLength(1);
    expect(run.lines('compiler')).toHaveLength(1);
    writeFileSync(join(run.watched, 'main.js'), 'changed');
    await run.waitFor(() => run.apiLines().length === 2);
    expect(run.messages.join('\n')).toContain('a file changed; restarting the API');
    run.stop();
    expect(await run.done).toBe(0);
  }, 30_000);

  it('restarts a running API when a watched file changes and it becomes ready again', async () => {
    const run = await scene({});
    await run.waitFor(() => run.messages.includes('the API is ready'));
    const firstPid = run.pidOf(run.apiLines()[0]);
    writeFileSync(join(run.watched, 'main.js'), 'changed');
    await run.waitFor(() => run.apiLines().length === 2);
    await run.waitFor(() => run.messages.filter((message) => message === 'the API is ready').length === 2);
    expect(alive(firstPid)).toBe(false);
    run.stop();
    expect(await run.done).toBe(0);
  }, 30_000);

  it('stops the others and exits 1 naming a child that stops by itself', async () => {
    const run = await scene({}, { childEnv: { EXIT_AFTER_MS: '800' } });
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('a compiler stopped by itself (exit code 2)');
    expect(alive(run.pidOf(run.apiLines()[0]))).toBe(false);
  }, 30_000);
});

describe('stopping', () => {
  it('stops the grandchildren of a child as well, and a child that ignores the request to stop, before it returns', async () => {
    const run = await scene({}, { childEnv: { GRANDCHILD: '1', IGNORE_TERM: '1' } });
    await run.waitFor(() => run.messages.includes('the API is ready') && run.lines('grandchild').length === 1);
    const compiler = run.pidOf(run.lines('compiler')[0]);
    const grandchild = run.pidOf(run.lines('grandchild')[0]);
    expect(alive(compiler) && alive(grandchild)).toBe(true);
    run.stop();
    expect(await run.done).toBe(0);
    expect(alive(compiler)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 30_000);

  it('stops everything and rejects when the API launch itself fails after the children started (a second report that throws)', async () => {
    const started: number[] = [];
    let reports = 0;
    const run = await scene({}, {
      onPids: (pids) => {
        started.push(...pids);
        reports += 1;
        if (reports === 2) throw new Error('the launch failed');
      },
    });
    await expect(run.done).rejects.toThrow('the launch failed');
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(started.some((pid) => alive(pid))).toBe(false);
  }, 30_000);

  it('stops what it started when the setup itself fails, and rejects with that failure', async () => {
    const started: number[] = [];
    const run = await scene({}, {
      onPids: (pids) => {
        started.push(...pids);
        throw new Error('the setup failed');
      },
    });
    await expect(run.done).rejects.toThrow('the setup failed');
    expect(started).toHaveLength(1);
    expect(started.some((pid) => alive(pid))).toBe(false);
  }, 30_000);
});
