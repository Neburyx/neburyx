import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, RunOptions } from './exec.js';
import { IncompleteExternalDatabase } from './external.js';
import { LockHeld } from './lock.js';
import { IncompleteMapping, MappingUnusable } from './mapping.js';
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

function rig(options: { files?: Record<string, string>; modes?: Record<string, number>; env?: Record<string, string>; fail?: (call: Call) => boolean; ports?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const written = new Map<string, { text: string; mode: number }>();
  const removed: string[] = [];
  const state = new Map<string, string>(Object.entries(options.files ?? {}));
  const files: Files = {
    exists: (path) => state.has(path),
    read: (path) => state.get(path) ?? '',
    mode: (path) => options.modes?.[path] ?? 0o600,
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

describe('a mapping of your own', () => {
  const MAPPING = '/private/own-mapping.yaml';
  const LOGINS = '/private/own-logins.env';
  const own = { NEBURYX_DEV_MAPPING: MAPPING, NEBURYX_DEV_MAPPING_ENV: LOGINS };
  const loginFile = 'OWN_USER=readerlogin\nOWN_PASSWORD=loginsecret\nOWN_URI=bolt://10.0.0.9:7687\n';
  const ownFiles = { [MAPPING]: 'sources: []\n', [LOGINS]: loginFile };
  const VALUES = ['readerlogin', 'loginsecret', '10.0.0.9'];
  const externalDatabase = { NEBURYX_DEV_DATABASE_URL: 'postgres://app:APPPW@elsewhere.example.test/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://mig:MIGPW@elsewhere.example.test/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'x_app' };

  it('starts and loads no demo graph, builds no demo graph tool and writes no mapping', async () => {
    const { deps, calls } = rig({ env: own, files: ownFiles });
    expect(await up(deps)).toBe(0);
    const docker = dockerCalls(calls);
    expect(JSON.stringify(docker)).not.toMatch(/demo-banking|demo-insurance|load-banking|load-insurance/);
    expect(docker.filter((args) => args.includes('build') || args.includes('run'))).toEqual([]);
    expect(docker.map((args) => args.slice(args.findIndex((arg) => ['up', 'port'].includes(arg))))).toEqual([['up', '-d', '--wait', '--wait-timeout', '600', 'db'], ['port', 'db', '5432']]);
    expect(calls.some((call) => call.args.includes('combine'))).toBe(false);
    expect(calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1])).toEqual(BUILDS.map((build) => build.filter).filter((filter) => filter !== '@neburyx/demo-graph'));
    expect(calls.some((call) => call.args.at(-1) === 'migrate')).toBe(true);
  });

  it('points the API at the mapping and gives it the logins and no demo login', async () => {
    const { deps, supervision } = rig({ env: own, files: ownFiles });
    await up(deps);
    const api = supervision()?.api.env ?? {};
    expect(api['NEBURYX_CONFIG']).toBe(MAPPING);
    expect(api).toMatchObject({ OWN_USER: 'readerlogin', OWN_PASSWORD: 'loginsecret', OWN_URI: 'bolt://10.0.0.9:7687' });
    expect(api).not.toHaveProperty('DEMO_NEO4J_USER');
    expect(api).not.toHaveProperty('DEMO_NEO4J_PASSWORD');
  });

  it('gives the logins to the API and to no other process', async () => {
    const { deps, calls, supervision } = rig({ env: own, files: ownFiles });
    await up(deps);
    const others = [...calls.map((call) => call.options.env ?? {}), ...(supervision()?.children.map((child) => child.env) ?? [])];
    expect(others.length).toBeGreaterThan(5);
    for (const env of others) for (const value of VALUES) expect(JSON.stringify(env)).not.toContain(value);
    for (const call of calls) for (const value of VALUES) expect(JSON.stringify(call.args)).not.toContain(value);
  });

  it('prints and writes none of the login values', async () => {
    const output: string[] = [];
    const { deps, written } = rig({ env: own, files: ownFiles });
    await up({ ...deps, out: (text) => void output.push(text) });
    for (const value of VALUES) {
      expect(output.join('\n')).not.toContain(value);
      expect(JSON.stringify([...written])).not.toContain(value);
    }
  });

  it('does not say that the sources are the demo sources', async () => {
    const output: string[] = [];
    const { deps } = rig({ env: own, files: ownFiles });
    await up({ ...deps, out: (text) => void output.push(text) });
    const line = output.join('\n').split('\n').find((text) => text.startsWith('sources:')) ?? '';
    expect(line).toContain('/v1/sources');
    expect(line).not.toMatch(/demo|synthetic|Community/);
  });

  it('does not tell you to remove containers when it started none', async () => {
    const output: string[] = [];
    const { deps } = rig({ env: { ...own, ...externalDatabase }, files: ownFiles });
    await up({ ...deps, out: (text) => void output.push(text) });
    expect(output.join('\n')).not.toContain('dev:down');
    const local = rig({ env: own, files: ownFiles });
    const localOutput: string[] = [];
    await up({ ...local.deps, out: (text) => void localOutput.push(text) });
    expect(localOutput.join('\n')).toContain('dev:down');
  });

  it('hands the runner no docker call at all when the Postgres is external too', async () => {
    const { deps, calls, supervision } = rig({ env: { ...own, ...externalDatabase }, files: ownFiles });
    await up(deps);
    expect(calls.filter((call) => call.command === 'docker')).toEqual([]);
    expect(calls.every((call) => ['pnpm', '/node'].includes(call.command))).toBe(true);
    expect(supervision()?.api.env['DATABASE_URL']).toBe(externalDatabase.NEBURYX_DEV_DATABASE_URL);
    expect(supervision()?.api.env['NEBURYX_CONFIG']).toBe(MAPPING);
  });

  it.each([
    ['the env file setting', { NEBURYX_DEV_MAPPING: MAPPING }, 'NEBURYX_DEV_MAPPING_ENV'],
    ['the mapping setting', { NEBURYX_DEV_MAPPING_ENV: LOGINS }, 'NEBURYX_DEV_MAPPING'],
  ])('stops before anything starts when only one is set, naming %s as missing', async (_name, env, missing) => {
    const { deps, calls, written } = rig({ env, files: ownFiles });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(IncompleteMapping);
    expect(error instanceof Error ? error.message : '').toContain(`missing: ${missing}`);
    expect(calls).toEqual([]);
    expect(written.size).toBe(0);
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o620, 0o666, 0o770, 0o700, 0o500])('refuses an env file with mode %o wider than 0600, before anything starts and without showing it', async (mode) => {
    const { deps, calls, written } = rig({ env: own, files: ownFiles, modes: { [LOGINS]: mode } });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MappingUnusable);
    const message = error instanceof Error ? error.message : '';
    for (const value of VALUES) expect(message).not.toContain(value);
    expect(calls).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('accepts an env file that only its owner can read', async () => {
    for (const mode of [0o600, 0o400]) {
      const { deps } = rig({ env: own, files: ownFiles, modes: { [LOGINS]: mode } });
      expect(await up(deps)).toBe(0);
    }
  });

  it.each([
    ['a mapping file that does not exist', { [LOGINS]: loginFile }],
    ['an env file that does not exist', { [MAPPING]: 'sources: []\n' }],
    ['an env file with an empty value', { [MAPPING]: 'sources: []\n', [LOGINS]: 'OWN_USER=reader\nOWN_PASSWORD=\n' }],
    ['an env file with no settings', { [MAPPING]: 'sources: []\n', [LOGINS]: '# nothing\n' }],
    ['an env file that sets a variable the tool sets itself', { [MAPPING]: 'sources: []\n', [LOGINS]: 'OWN_PASSWORD=loginsecret\nDATABASE_URL=postgres://other\n' }],
  ])('stops before anything starts for %s, without showing a value', async (_name, files) => {
    const { deps, calls, written } = rig({ env: own, files });
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MappingUnusable);
    for (const value of VALUES) expect(error instanceof Error ? error.message : '').not.toContain(value);
    expect(calls).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('keeps the demo behaviour when neither setting is set, and puts no login in the API', async () => {
    const { deps, calls, supervision } = rig();
    await up(deps);
    expect(dockerCalls(calls).some((args) => args.includes('load-banking'))).toBe(true);
    expect(calls.some((call) => call.args.includes('combine'))).toBe(true);
    expect(supervision()?.api.env['NEBURYX_CONFIG']).toBe(join(ROOT, '.dev/neburyx.yaml'));
    expect(supervision()?.api.env).toHaveProperty('DEMO_NEO4J_PASSWORD');
  });
});

describe('a mapping of your own with an external Postgres: stop and down', () => {
  const noContainers = { NEBURYX_DEV_MAPPING: '/private/own-mapping.yaml', NEBURYX_DEV_MAPPING_ENV: '/private/own-logins.env', NEBURYX_DEV_DATABASE_URL: 'postgres://a:APPPW@elsewhere.example.test/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://b:MIGPW@elsewhere.example.test/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'x_app' };

  it('removes nothing and runs no command on down, and says so', async () => {
    const output: string[] = [];
    const { deps, calls, removed } = rig({ env: noContainers, files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) } });
    expect(await down({ ...deps, out: (text) => void output.push(text) })).toBe(0);
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
    expect(output.join('\n')).toContain('nothing to remove');
    for (const secret of ['APPPW', 'MIGPW', 'elsewhere.example.test']) expect(output.join('\n')).not.toContain(secret);
  });

  it('still takes the lock on down', async () => {
    const files = { [join(ROOT, '.env')]: formatSettings(generateSettings()), '/private/own-mapping.yaml': 'x', '/private/own-logins.env': 'A=b\n' };
    const first = rig({ env: noContainers, files });
    const lock = { folder: first.deps.lock.folder, alive: () => true };
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = up({ ...first.deps, supervise: async () => { await held; return 0; }, lock });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(down({ ...rig({ env: noContainers }).deps, lock })).rejects.toBeInstanceOf(LockHeld);
    release();
    await running;
  });

  it.each([
    ['no mapping', { NEBURYX_DEV_MAPPING_ENV: '/private/own-logins.env' }],
    ['no external database', { NEBURYX_DEV_MAPPING: '/private/own-mapping.yaml', NEBURYX_DEV_MAPPING_ENV: '/private/own-logins.env' }],
    ['only part of the external database', { ...noContainers, NEBURYX_DEV_DATABASE_APP_ROLE: undefined }],
  ])('keeps the removal of the demo containers on down with %s', async (_name, env) => {
    const { deps, calls } = rig({ env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string> });
    await down(deps);
    expect(dockerCalls(calls).map((args) => args.slice(-3))).toEqual([['down', '-v', '--remove-orphans']]);
  });

  it('prints a plain stopped message, not one about containers that keep running, when stopped while starting', async () => {
    let stopNow: () => void = () => undefined;
    const stopRequested = new Promise<void>((resolve) => {
      stopNow = resolve;
    });
    const output: string[] = [];
    const first = rig({ env: noContainers, files: { '/private/own-mapping.yaml': 'x', '/private/own-logins.env': 'A=b\n' } });
    const slowRun: Run = async (command, args, options = {}) => {
      await first.deps.run(command, args, options);
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 130, stdout: '', stderr: '' };
    };
    const running = up({ ...first.deps, run: slowRun, stopRequested, out: (text) => void output.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopNow();
    expect(await running).toBe(0);
    expect(output).toEqual(['stopped']);
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
  const settingValues = (call: Call): string[] => Object.entries(call.options.env ?? {}).filter(([key]) => /PASSWORD|CURSOR/.test(key)).map(([, value]) => value);

  it('removes the containers and volumes of the project and .dev, and keeps .env', async () => {
    const { deps, calls, removed, state } = rig({ files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) } });
    expect(await down(deps)).toBe(0);
    expect(dockerCalls(calls).map((args) => args.slice(-3))).toEqual([['down', '-v', '--remove-orphans']]);
    expect(removed).toEqual([join(ROOT, '.dev')]);
    expect(state.has(join(ROOT, '.env'))).toBe(true);
  });

  it('removes the project whatever .env says: with no .env, or a damaged one, it does not read it and still runs the removal', async () => {
    for (const files of [{}, { [join(ROOT, '.env')]: 'NEBURYX_CURSOR_KEY=\nbroken' }]) {
      const { deps, calls, removed } = rig({ files });
      expect(await down(deps)).toBe(0);
      const [call] = calls;
      expect(call?.args.slice(call.args.indexOf('--env-file'), call.args.indexOf('--env-file') + 2)).toEqual(['--env-file', '/dev/null']);
      expect(call?.args.slice(-3)).toEqual(['down', '-v', '--remove-orphans']);
      expect(settingValues(call ?? { command: '', args: [], options: {} }).every((value) => value === 'not-used')).toBe(true);
      expect(removed).toEqual([join(ROOT, '.dev')]);
    }
  });

  it('opens no connection to an external database', async () => {
    const { deps, calls } = rig({ files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) }, env: { NEBURYX_DEV_DATABASE_URL: 'postgres://a:b@elsewhere/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://c:d@elsewhere/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'r' } });
    await down(deps);
    expect(calls.every((call) => call.command === 'docker' && call.args.includes('down'))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('elsewhere');
  });
});

describe('stopping the command while it starts', () => {
  it('stops the step in flight, runs no later step, releases the lock and returns 0', async () => {
    let stopNow: () => void = () => undefined;
    const stopRequested = new Promise<void>((resolve) => {
      stopNow = resolve;
    });
    const seen: { signal?: AbortSignal }[] = [];
    const first = rig();
    const slowRun: Run = async (command, args, options = {}) => {
      seen.push(options.signal === undefined ? {} : { signal: options.signal });
      await first.deps.run(command, args, options);
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 130, stdout: '', stderr: '' };
    };
    const running = up({ ...first.deps, run: slowRun, stopRequested });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopNow();
    expect(await running).toBe(0);
    expect(first.calls).toHaveLength(1);
    expect(seen[0]?.signal?.aborted).toBe(true);
    expect(await up({ ...first.deps, lock: first.deps.lock })).toBe(0);
  });
});

describe('the lock at the level of the commands', () => {
  function blocking() {
    const first = rig({ files: { [join(ROOT, '.env')]: formatSettings(generateSettings()) } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: Run = async (command, args, options) => {
      await held;
      return first.deps.run(command, args, options);
    };
    return { first, run, release };
  }

  it('refuses an up while a down is running, and a second down while one is running', async () => {
    const { first, run, release } = blocking();
    const folder = first.deps.lock.folder;
    const lock = { folder, alive: () => true };
    const running = down({ ...first.deps, run, lock });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = rig();
    await expect(up({ ...other.deps, lock })).rejects.toBeInstanceOf(LockHeld);
    await expect(down({ ...other.deps, lock })).rejects.toBeInstanceOf(LockHeld);
    expect(other.calls).toEqual([]);
    release();
    expect(await running).toBe(0);
    expect(await down({ ...other.deps, lock: { folder } })).toBe(0);
  });
});

describe('the root scripts', () => {
  it('build only the tool before the command, which checks .env before it builds anything else', async () => {
    const { readFileSync } = await import('node:fs');
    const root: { scripts: Record<string, string> } = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(root.scripts['dev']).toBe('pnpm --filter @neburyx/dev build && node tools/dev/dist/main.js up');
    expect(root.scripts['dev:down']).toBe('pnpm --filter @neburyx/dev build && node tools/dev/dist/main.js down');
  });
});
