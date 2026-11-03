import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { API_READY_TIMEOUT_MS, supervise, type ApiSpec, type ChildSpec } from './supervisor.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'testing');
const folders: string[] = [];
afterEach(() => {
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

async function scene(apiEnv: Record<string, string>, options: { readyTimeoutMs?: number; childEnv?: Record<string, string> } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'dev-supervisor-'));
  folders.push(folder);
  const log = join(folder, 'log.txt');
  const watched = join(folder, 'dist');
  mkdirSync(watched);
  writeFileSync(log, '');
  const port = await freePort();
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
  const waitFor = async (condition: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`condition not met; messages: ${messages.join(' | ')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 400));
  const done = supervise({ children: [child], api, out: (text) => void messages.push(text), stopRequested });
  return { messages, stop, done, lines, waitFor, watched, apiLines: () => lines('start') };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the API supervisor', () => {
  it('uses a startup limit of seven gate deadlines of 10 s plus 50 s', () => {
    expect(API_READY_TIMEOUT_MS).toBe(120_000);
  });

  it('waits for an API that becomes ready after a delay shorter than the limit, and stops everything with exit 0 when asked', async () => {
    const run = await scene({ START_DELAY_MS: '1200' });
    await run.waitFor(() => run.messages.includes('the API is ready'));
    run.stop();
    expect(await run.done).toBe(0);
    const [api] = run.apiLines();
    const pid = Number(api?.split(' ')[1]);
    await run.waitFor(() => !alive(pid));
  }, 30_000);

  it('stops every child and exits 1 naming the API when it does not become ready within the limit', async () => {
    const run = await scene({ NEVER_LISTEN: '1' }, { readyTimeoutMs: 1500 });
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
    const pid = Number(run.lines('compiler')[0]?.split(' ')[1]);
    await run.waitFor(() => !alive(pid));
  }, 30_000);

  it('still exits 1 for an API that never becomes ready when a file changes during its first start (the compiler writing its output)', async () => {
    const run = await scene({ NEVER_LISTEN: '1' }, { readyTimeoutMs: 2500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(run.watched, 'main.js'), 'first output');
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
    expect(run.messages.join('\n')).not.toContain('after the change');
  }, 30_000);

  it('exits 1 at once when the API fails to start', async () => {
    const started = Date.now();
    const run = await scene({ FAIL_AT_START: '1' });
    expect(await run.done).toBe(1);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(run.messages.join('\n')).toContain('the API did not become ready');
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
    const firstPid = Number(run.apiLines()[0]?.split(' ')[1]);
    writeFileSync(join(run.watched, 'main.js'), 'changed');
    await run.waitFor(() => run.apiLines().length === 2);
    await run.waitFor(() => run.messages.filter((message) => message === 'the API is ready').length === 2);
    await run.waitFor(() => !alive(firstPid));
    run.stop();
    expect(await run.done).toBe(0);
  }, 30_000);

  it('stops the others and exits 1 naming a child that stops by itself', async () => {
    const run = await scene({}, { childEnv: { EXIT_AFTER_MS: '800' } });
    expect(await run.done).toBe(1);
    expect(run.messages.join('\n')).toContain('a compiler stopped by itself (exit code 2)');
    const pid = Number(run.apiLines()[0]?.split(' ')[1]);
    await run.waitFor(() => !alive(pid));
  }, 30_000);
});
