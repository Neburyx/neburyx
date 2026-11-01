import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { rows } from '../testing/database.js';
import { docker, dockerOk, dockerStream } from './docker.js';
import { configurationFilesIn, containsText, extractLayers } from './scan.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const dockerfile = join(repository, 'deploy/docker/Dockerfile');
const TAG = `neburyx-image-test:${randomBytes(4).toString('hex')}`;
const HOST_ALIAS = 'host.docker.internal';
const STOP_WITHIN_MS = 5000;
const SENTINEL = `sentinel-${randomBytes(8).toString('hex')}`;
const SENTINEL_FILES = ['.env', 'neburyx.yaml'].map((name) => join(repository, name));
const execute = promisify(execFile);

let postgres: TestPostgres;
const containers: string[] = [];
const scratch: string[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
  for (const file of SENTINEL_FILES) {
    if (existsSync(file)) throw new Error(`${file} exists; the image test will not overwrite it`);
  }
  try {
    for (const file of SENTINEL_FILES) writeFileSync(file, `SECRET=${SENTINEL}\n`);
    await dockerStream(['build', '-f', dockerfile, '-t', TAG, '.'], repository);
  } finally {
    for (const file of SENTINEL_FILES) rmSync(file, { force: true });
  }
});

afterAll(async () => {
  for (const name of containers) await docker(['rm', '-f', name]);
  await docker(['rmi', '-f', TAG]);
  for (const folder of scratch) rmSync(folder, { recursive: true, force: true });
  await postgres.stop();
});

function viaHost(url: string): string {
  const reachable = new URL(url);
  reachable.hostname = HOST_ALIAS;
  return reachable.toString();
}

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await docker([
    'run', '--rm', '--add-host', `${HOST_ALIAS}:host-gateway`,
    '-e', `DATABASE_MIGRATION_URL=${viaHost(database.ownerUrl)}`,
    '-e', `DATABASE_APP_ROLE=${database.appRole}`,
    TAG, 'migrate',
  ]);
  expect(result.code, result.stderr).toBe(0);
  return database;
}

async function startApi(database: TestDatabase, command: readonly string[] = ['api']): Promise<{ readonly name: string; readonly url: string }> {
  const name = `neburyx-image-${randomBytes(4).toString('hex')}`;
  containers.push(name);
  await dockerOk([
    'run', '-d', '--name', name, '--add-host', `${HOST_ALIAS}:host-gateway`, '-p', '127.0.0.1::8080',
    '-e', `DATABASE_URL=${viaHost(database.appUrl)}`,
    TAG, ...command,
  ]);
  const mapping = await dockerOk(['port', name, '8080/tcp']);
  const url = `http://127.0.0.1:${mapping.split('\n')[0]?.split(':').pop()}`;
  await vi.waitFor(async () => expect((await fetch(`${url}/v1/me`)).status).toBe(200), { timeout: 60_000, interval: 250 });
  return { name, url };
}

async function insideImage(script: string): Promise<{ readonly code: number; readonly stdout: string }> {
  const result = await docker(['run', '--rm', '--entrypoint', 'sh', TAG, '-c', script]);
  return { code: result.code, stdout: result.stdout };
}

describe('the image as built', () => {
  it('holds the compiled API, the built web app and the SQL migrations', async () => {
    const found = await insideImage('ls /app/dist/main.js /app/dist/cli.js /app/web/index.html /app/migrations/0001-baseline.sql');
    expect(found.code).toBe(0);
  });

  it('is a Node 24 runtime without the web sources, the TypeScript compiler or the build tool', async () => {
    expect((await insideImage('node --version')).stdout).toMatch(/^v24\./);
    const leftovers = await insideImage(`test ! -e /app/web/src && test ! -e /repo && ! command -v tsc && ! command -v vite && find /app -type d \\( -name typescript -o -name vite \\) -path '*/node_modules/*' 2>/dev/null | head -1`);
    expect(leftovers).toEqual({ code: 0, stdout: '' });
  });

  it('is built in more than one stage, the first of them named builder', () => {
    const stages = readFileSync(dockerfile, 'utf8').split('\n').filter((line) => /^FROM\s/i.test(line));
    expect(stages.length).toBeGreaterThanOrEqual(2);
    expect(stages[0]).toMatch(/\sAS\s+builder$/i);
    expect(stages.at(-1)).not.toMatch(/\sAS\s/i);
  });
});

describe('the migrate command', () => {
  it('migrates an empty database and exits 0', async () => {
    const database = await migratedDatabase();
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name')).toEqual([
      { name: '0001-baseline' },
      { name: '0002-deployment-and-users' },
      { name: '0003-applied-migrations-function' },
    ]);
  });
});

describe('the api command', () => {
  it('serves /v1/me for the local principal and the web app at /', async () => {
    const database = await migratedDatabase();
    const api = await startApi(database);
    const me = await fetch(`${api.url}/v1/me`);
    expect(await me.json()).toMatchObject({ principal: { displayName: 'Local workspace', role: 'administrator' }, edition: 'community' });
    const page = await fetch(`${api.url}/`);
    const shipped = await dockerOk(['run', '--rm', '--entrypoint', 'cat', TAG, '/app/web/index.html']);
    expect(page.status).toBe(200);
    expect((await page.text()).trim()).toBe(shipped);
  });

  it('is what the image runs when it is started with no command', async () => {
    const database = await migratedDatabase();
    const api = await startApi(database, []);
    expect((await fetch(`${api.url}/v1/me`)).status).toBe(200);
  });

  it.each([
    ['SIGTERM', false],
    ['SIGINT', false],
    ['SIGTERM', true],
    ['SIGINT', true],
  ] as const)('stops and exits 0 within five seconds of %s, with a request in progress: %s', async (signal, inProgress) => {
    const database = await migratedDatabase();
    const api = await startApi(database);
    const socket = connect(Number(new URL(api.url).port), '127.0.0.1');
    socket.on('error', () => undefined);
    if (inProgress) {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write('GET /v1/me HTTP/1.1\r\nHost: localhost\r\n');
    }
    const sent = Date.now();
    await dockerOk(['kill', '--signal', signal, api.name]);
    expect(await dockerOk(['wait', api.name])).toBe('0');
    expect(Date.now() - sent).toBeLessThan(STOP_WITHIN_MS);
    socket.destroy();
  });
});

describe('a command the image does not have', () => {
  it('exits 2 and prints the usage line', async () => {
    const result = await docker(['run', '--rm', TAG, 'bogus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('usage: neburyx api | migrate\n');
  });
});

describe('a file mounted into the container', () => {
  it('can be read from inside', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'image-mount-'));
    scratch.push(folder);
    writeFileSync(join(folder, 'neburyx.yaml'), 'mounted: true\n');
    const result = await docker(['run', '--rm', '-v', `${join(folder, 'neburyx.yaml')}:/mnt/neburyx.yaml:ro`, '--entrypoint', 'cat', TAG, '/mnt/neburyx.yaml']);
    expect(result).toMatchObject({ code: 0, stdout: 'mounted: true\n' });
    expect(existsSync(join(folder, 'neburyx.yaml'))).toBe(true);
  });
});

async function unpackedImage(): Promise<{ readonly saved: string; readonly layers: readonly string[] }> {
  const folder = mkdtempSync(join(tmpdir(), 'image-save-'));
  scratch.push(folder);
  const archive = join(folder, 'image.tar');
  await dockerOk(['save', '-o', archive, TAG]);
  const saved = join(folder, 'saved');
  mkdirSync(saved);
  await execute('tar', ['-xf', archive, '-C', saved], { maxBuffer: 256 * 1024 * 1024 });
  const layersFolder = join(folder, 'layers');
  mkdirSync(layersFolder);
  return { saved, layers: await extractLayers(saved, layersFolder) };
}

describe('what the image holds', () => {
  it('has no trace of a .env file or a neburyx.yaml that was in the build context, in any layer, its environment or its history', async () => {
    const { saved, layers } = await unpackedImage();
    expect(layers.length).toBeGreaterThan(0);
    for (const where of [saved, ...layers]) expect(await containsText(where, SENTINEL)).toBe(false);
    expect(await dockerOk(['inspect', '--format', '{{json .Config}}', TAG])).not.toContain(SENTINEL);
    expect(await dockerOk(['history', '--no-trunc', '--format', '{{.CreatedBy}}', TAG])).not.toContain(SENTINEL);
  });

  it('configures no database setting and holds no file named neburyx.yaml or .env', async () => {
    const environment = z.array(z.string()).parse(JSON.parse(await dockerOk(['inspect', '--format', '{{json .Config.Env}}', TAG])));
    expect(environment.filter((entry) => /^(DATABASE_URL|DATABASE_MIGRATION_URL|DATABASE_APP_ROLE)=/.test(entry))).toEqual([]);
    const { layers } = await unpackedImage();
    for (const layer of layers) expect(configurationFilesIn(layer)).toEqual([]);
  });

  it('refuses to start the api command without DATABASE_URL, naming the key', async () => {
    const result = await docker(['run', '--rm', TAG, 'api']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('invalid configuration: DATABASE_URL\n');
  });
});

describe('who runs the container', () => {
  it('is not root', async () => {
    const database = await migratedDatabase();
    const api = await startApi(database);
    const owner = await dockerOk(['exec', api.name, 'sh', '-c', 'cat /proc/1/status | grep ^Uid']);
    expect(owner.split(/\s+/)[1]).not.toBe('0');
  });

  it('can read a mounted file but cannot write into the application folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'image-user-'));
    scratch.push(folder);
    writeFileSync(join(folder, 'neburyx.yaml'), 'mounted: true\n');
    const result = await docker([
      'run', '--rm', '-v', `${join(folder, 'neburyx.yaml')}:/mnt/neburyx.yaml:ro`, '--entrypoint', 'sh', TAG, '-c',
      'cat /mnt/neburyx.yaml && touch /app/new-file',
    ]);
    expect(result.stdout).toBe('mounted: true\n');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Permission denied/);
  });
});
