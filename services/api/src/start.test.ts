import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { start, type StartIo } from './start.js';
import { memoryAppStore } from './testing/app-store.js';
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
