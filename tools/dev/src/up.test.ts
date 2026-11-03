import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, RunOptions } from './exec.js';
import { IncompleteExternalDatabase } from './external.js';
import { LockHeld } from './lock.js';
import { formatSettings, generateSettings } from './settings.js';
import type { Supervision } from './supervisor.js';
import { BUILDS, down, SettingsInvalid, up, type Dependencies, type Files } from './up.js';

const ROOT = '/repo';
const lockFolders: string[] = [];
afterEach(() => {
  for (const folder of lockFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

function rig(options: { files?: Record<string, string>; env?: Record<string, string>; fail?: (call: Call) => boolean; ports?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const written = new Map<string, { text: string; mode: number }>();
  const removed: string[] = [];
  const state = new Map<string, string>(Object.entries(options.files ?? {}));
  const files: Files = {
    exists: (path) => state.has(path),
    read: (path) => state.get(path) ?? '',
    write: (path, text, mode) => {
      if (state.has(path)) throw new Error('would overwrite');
      state.set(path, text);
      written.set(path, { text, mode });
    },
    mkdir: () => undefined,
    remove: (path) => void removed.push(path),
  };
  const run: Run = async (command, args, runOptions = {}) => {
    const call = { command, args, options: runOptions };
    calls.push(call);
    if (options.fail?.(call) === true) return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('port')) return { code: 0, stdout: `${options.ports?.[args[args.length - 2] ?? ''] ?? '127.0.0.1:55000'}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  let supervision: Supervision | undefined;
  let filler = 0;
  let nextPort = 4000;
  const lockFolder = mkdtempSync(join(tmpdir(), 'dev-up-'));
  lockFolders.push(lockFolder);
  const deps: Dependencies = {
    root: ROOT,
    run,
    env: { PATH: '/bin', HOME: '/home/dev', ...options.env },
    out: () => undefined,
    random: (bytes) => Buffer.alloc(bytes, ++filler),
    files,
    nodePath: '/node',
    freePort: async () => nextPort++,
    supervise: async (given) => {
      supervision = given;
      return 0;
    },
    stopRequested: new Promise<void>(() => undefined),
    lock: { folder: lockFolder },
  };
  return { deps, calls, written, removed, supervision: () => supervision, state };
}

const dockerCalls = (calls: readonly Call[]): string[][] => calls.filter((call) => call.command === 'docker').map((call) => [...call.args]);

describe('pnpm dev up with no .env', () => {
  it('creates .env with mode 0600 from random values, builds, starts the databases and loaders, migrates and supervises', async () => {
    const { deps, calls, written, supervision } = rig();
    expect(await up(deps)).toBe(0);
    const env = written.get(join(ROOT, '.env'));
    expect(env?.mode).toBe(0o600);
    expect(env?.text).toContain('NEBURYX_CURSOR_KEY=');
    expect(calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1])).toEqual(BUILDS.map((build) => build.filter));

    const docker = dockerCalls(calls);
    expect(docker[0]).toEqual(['compose', '-p', 'neburyx-dev', '--env-file', join(ROOT, '.env'), '-f', join(ROOT, 'deploy/demo/compose.yaml'), '-f', join(ROOT, 'deploy/demo/compose.dev.yaml'), 'build', 'load-banking']);
    expect(docker[1]?.slice(-7)).toEqual(['up', '-d', '--wait', '--wait-timeout', '600', 'db', 'demo-banking-graph', 'demo-insurance-graph'].slice(-7));
    expect(docker.filter((args) => args.includes('run')).map((args) => args.at(-1))).toEqual(['load-banking', 'load-insurance']);
    const order = calls.map((call) => (call.command === 'docker' ? `docker ${call.args.find((arg) => ['build', 'up', 'run', 'port'].includes(arg))}` : call.args.at(-1) ?? call.command));
    expect(order.indexOf('docker run')).toBeGreaterThan(order.indexOf('docker up'));
    expect(order.lastIndexOf('migrate')).toBeGreaterThan(order.lastIndexOf('docker port'));
    expect(supervision()?.api.healthUrl).toBe('http://127.0.0.1:4000/healthz');
  });

  it('starts no api, migrate or config container', async () => {
    const { deps, calls } = rig();
    await up(deps);
    const started = calls.filter((call) => call.command === 'docker' && call.args.some((arg) => ['up', 'run'].includes(arg))).map((call) => call.args.join(' '));
    for (const text of started) for (const service of [' api', ' migrate', ' config']) expect(text.endsWith(service) || text.includes(`${service} `)).toBe(false);
  });

  it('runs migrate with the migration URL and no other setting, and the API with the app URL and no administrator or migration password', async () => {
    const { deps, calls, written, supervision } = rig({ ports: { db: '127.0.0.1:55432' } });
    await up(deps);
    const text = written.get(join(ROOT, '.env'))?.text ?? '';
    const secret = (key: string): string => new RegExp(`${key}=(.*)`).exec(text)?.[1] ?? '';
    const migrate = calls.find((call) => call.args.at(-1) === 'migrate');
    expect(migrate?.options.env?.['DATABASE_MIGRATION_URL']).toBe(`postgres://neburyx_migrate:${secret('NEBURYX_DB_MIGRATION_PASSWORD')}@127.0.0.1:55432/neburyx`);
    expect(migrate?.options.env?.['DATABASE_APP_ROLE']).toBe('neburyx_app');
    expect(Object.keys(migrate?.options.env ?? {}).sort()).toEqual(['DATABASE_APP_ROLE', 'DATABASE_MIGRATION_URL', 'HOME', 'PATH']);
    const api = supervision()?.api.env ?? {};
    expect(api['DATABASE_URL']).toBe(`postgres://neburyx_app:${secret('NEBURYX_DB_APP_PASSWORD')}@127.0.0.1:55432/neburyx`);
    expect(api['NEBURYX_HOST']).toBe('127.0.0.1');
    const apiText = JSON.stringify(api);
    expect(apiText).not.toContain(secret('NEBURYX_DB_ADMIN_PASSWORD'));
    expect(apiText).not.toContain(secret('NEBURYX_DB_MIGRATION_PASSWORD'));
  });

  it('writes the mapping from the packs with each source at its published loopback address', async () => {
    const { deps, calls } = rig({ ports: { 'demo-banking-graph': '127.0.0.1:55001', 'demo-insurance-graph': '127.0.0.1:55002' } });
    await up(deps);
    const combine = calls.find((call) => call.args.includes('combine'));
    expect(combine?.args).toEqual([join(ROOT, 'tools/demo-graph/dist/main.js'), 'combine', '--packs', 'banking-fraud,insurance-claims', '--addresses', 'banking-demo=bolt://127.0.0.1:55001,insurance-demo=bolt://127.0.0.1:55002', '--out', join(ROOT, '.dev/neburyx.yaml')]);
  });

  it('starts the compilers, the API supervisor and the web dev server on loopback, with the API address passed to the web server', async () => {
    const { deps, supervision } = rig();
    await up(deps);
    const given = supervision();
    expect(given?.children.map((child) => child.name)).toEqual(['the contracts compiler', 'the API compiler', 'the web dev server']);
    expect(given?.children.map((child) => child.args.join(' '))[0]).toContain('-p tsconfig.build.json --watch');
    const web = given?.children.find((child) => child.name === 'the web dev server');
    expect(web?.args).toContain('127.0.0.1');
    expect(web?.env['NEBURYX_DEV_API_URL']).toBe('http://127.0.0.1:4000');
    expect(given?.api.watch).toEqual([join(ROOT, 'services/api/dist'), join(ROOT, 'packages/contracts/dist')]);
  });
});

describe('pnpm dev up with an existing .env', () => {
  const good = formatSettings(generateSettings());

  it('leaves the file as it is', async () => {
    const { deps, written } = rig({ files: { [join(ROOT, '.env')]: good } });
    await up(deps);
    expect(written.size).toBe(0);
  });

  it('stops before any build or container when a key is missing, naming it and not changing the file', async () => {
    const without = good.split('\n').filter((line) => !line.startsWith('DEMO_NEO4J_PASSWORD')).join('\n');
    const { deps, calls, state } = rig({ files: { [join(ROOT, '.env')]: without } });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SettingsInvalid);
    expect(error instanceof Error ? error.message : '').toContain('DEMO_NEO4J_PASSWORD');
    expect(calls).toEqual([]);
    expect(state.get(join(ROOT, '.env'))).toBe(without);
  });
});

describe('a step that fails', () => {
  it.each([
    ['a build', (call: Call) => call.args.includes('@neburyx/api')],
    ['a loader', (call: Call) => call.args.includes('load-insurance') && call.args.includes('run')],
    ['the migration', (call: Call) => call.args.at(-1) === 'migrate'],
  ])('stops before the API starts when %s fails, and exits with a message naming the step', async (_name, fail) => {
    const { deps, supervision } = rig({ fail });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(supervision()).toBeUndefined();
  });

  it('refuses a published port that is not on 127.0.0.1', async () => {
    const { deps } = rig({ ports: { db: '0.0.0.0:55432' } });
    await expect(up(deps)).rejects.toThrow(/finding the published port of db/);
  });
});

describe('the external Postgres', () => {
  const external = { NEBURYX_DEV_DATABASE_URL: 'postgres://app:APPPW@elsewhere.example.test/neburyx_dev', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://mig:MIGPW@elsewhere.example.test/neburyx_dev', NEBURYX_DEV_DATABASE_APP_ROLE: 'neburyx_dev_app' };

  it('starts no db container and uses the given URLs and role', async () => {
    const { deps, calls, supervision } = rig({ env: external });
    await up(deps);
    const waited = calls.find((call) => call.args.includes('--wait'));
    expect(waited?.args.slice(-2)).toEqual(['demo-banking-graph', 'demo-insurance-graph']);
    expect(waited?.args).not.toContain('db');
    expect(calls.some((call) => call.command === 'docker' && call.args.includes('port') && call.args.includes('db'))).toBe(false);
    const migrate = calls.find((call) => call.args.at(-1) === 'migrate');
    expect(migrate?.options.env).toMatchObject({ DATABASE_MIGRATION_URL: external.NEBURYX_DEV_DATABASE_MIGRATION_URL, DATABASE_APP_ROLE: 'neburyx_dev_app' });
    expect(supervision()?.api.env['DATABASE_URL']).toBe(external.NEBURYX_DEV_DATABASE_URL);
  });

  it('stops before anything starts when only some of the variables are set, naming the missing ones and holding no value', async () => {
    const { deps, calls } = rig({ env: { NEBURYX_DEV_DATABASE_URL: external.NEBURYX_DEV_DATABASE_URL } });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(IncompleteExternalDatabase);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('NEBURYX_DEV_DATABASE_MIGRATION_URL');
    expect(message).not.toContain('APPPW');
    expect(message).not.toContain('elsewhere');
    expect(calls).toEqual([]);
  });

  it('prints no connection string, host or password of the external server', async () => {
    const output: string[] = [];
    const { deps } = rig({ env: external });
    await up({ ...deps, out: (text) => void output.push(text) });
    const text = output.join('\n');
    for (const secret of ['APPPW', 'MIGPW', 'elsewhere.example.test']) expect(text).not.toContain(secret);
  });
});

describe('the lock', () => {
  it('refuses a second run before any command, and is released when the run ends', async () => {
    const first = rig();
    const folder = first.deps.lock.folder;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = up({ ...first.deps, supervise: async () => { await held; return 0; }, lock: { ...first.deps.lock, alive: () => true } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = rig();
    const error: unknown = await up({ ...second.deps, lock: { folder, alive: () => true } }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(LockHeld);
    expect(second.calls).toEqual([]);
    await expect(down({ ...second.deps, lock: { folder, alive: () => true } })).rejects.toBeInstanceOf(LockHeld);
    expect(second.calls).toEqual([]);
    release();
    await running;
    expect(await up({ ...second.deps, lock: { folder } })).toBe(0);
  });
});

describe('pnpm dev down', () => {
  it('removes the containers and volumes of the project and .dev, and keeps .env', async () => {
    const { deps, calls, removed, state } = rig({ files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) } });
    expect(await down(deps)).toBe(0);
    expect(dockerCalls(calls).map((args) => args.slice(-3))).toEqual([['down', '-v', '--remove-orphans']]);
    expect(removed).toEqual([join(ROOT, '.dev')]);
    expect(state.has(join(ROOT, '.env'))).toBe(true);
  });

  it('exits 0 and runs no Docker command when there is no .env, so nothing was ever started', async () => {
    const { deps, calls, removed } = rig();
    expect(await down(deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(removed).toEqual([join(ROOT, '.dev')]);
  });

  it('opens no connection to an external database', async () => {
    const { deps, calls } = rig({ files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) }, env: { NEBURYX_DEV_DATABASE_URL: 'postgres://a:b@elsewhere/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://c:d@elsewhere/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'r' } });
    await down(deps);
    expect(calls.every((call) => call.command === 'docker' && call.args.includes('down'))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('elsewhere');
  });
});
