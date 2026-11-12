import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigUnusable } from './config.js';
import type { Run, RunOptions } from './exec.js';
import type { Files } from './files.js';
import { LockHeld } from './lock.js';
import { MappingUnusable } from './mapping.js';
import type { Supervision } from './supervisor.js';
import { BUILDS, up, type Dependencies } from './up.js';

const HOME = '/home/dev';
const SETTINGS = `${HOME}/.config/neburyx/dev.env`;
const MAPPING = '/private/own-mapping.yaml';
const LOGINS = '/private/own-logins.env';
const LOGIN_TEXT = 'OWN_USER=readerlogin\nOWN_PASSWORD=loginsecret\nOWN_URI=bolt://10.0.0.9:7687\n';
const SETTINGS_TEXT = [`NEBURYX_DEV_MAPPING=${MAPPING}`, `NEBURYX_DEV_MAPPING_ENV=${LOGINS}`, 'NEBURYX_DEV_DATABASE_URL=postgres://app:APPPW@elsewhere.example.test/x', 'NEBURYX_DEV_DATABASE_MIGRATION_URL=postgres://mig:MIGPW@elsewhere.example.test/x', 'NEBURYX_DEV_DATABASE_APP_ROLE=x_app', ''].join('\n');
const VALUES = ['readerlogin', 'loginsecret', '10.0.0.9', 'APPPW', 'MIGPW', 'elsewhere.example.test'];

const lockFolders: string[] = [];
afterEach(() => {
  for (const folder of lockFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

function rig(options: { files?: Record<string, string>; modes?: Record<string, number>; env?: Record<string, string>; fail?: (call: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const state = new Map<string, string>(Object.entries(options.files ?? { [SETTINGS]: SETTINGS_TEXT, [MAPPING]: 'sources: []\n', [LOGINS]: LOGIN_TEXT }));
  const files: Files = {
    exists: (path) => state.has(path),
    read: (path) => (reads.push(path), state.get(path) ?? ''),
    mode: (path) => options.modes?.[path] ?? 0o600,
  };
  const run: Run = async (command, args, runOptions = {}) => {
    const call = { command, args, options: runOptions };
    calls.push(call);
    return { code: options.fail?.(call) === true ? 1 : 0, stdout: '', stderr: '' };
  };
  let supervision: Supervision | undefined;
  const ports: number[] = [];
  let nextPort = 4000;
  const lockFolder = mkdtempSync(join(tmpdir(), 'dev-up-'));
  lockFolders.push(lockFolder);
  const deps: Dependencies = {
    root: '/repo',
    run,
    env: { PATH: '/bin', HOME, ...options.env },
    out: () => undefined,
    random: (bytes) => Buffer.alloc(bytes, 9),
    files,
    nodePath: '/node',
    freePort: async () => (ports.push(nextPort), nextPort++),
    supervise: async (given) => {
      supervision = given;
      return 0;
    },
    stopRequested: new Promise<void>(() => undefined),
    lock: { folder: lockFolder },
  };
  return { deps, calls, reads, ports, supervision: () => supervision, state };
}

const ROOT = '/repo';
const dockerCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => call.command === 'docker' || call.args.includes('compose'));

describe('pnpm dev', () => {
  it('starts the migrate step and the API through the entry script, and gives them the profile and the migrate step the mapping, only when the profile is set', async () => {
    const without = rig();
    await up(without.deps);
    expect(JSON.stringify(without.calls.at(-1)?.options.env)).not.toContain('NEBURYX_PROFILE');
    expect(without.calls.at(-1)?.options.env).not.toHaveProperty('NEBURYX_CONFIG');
    expect(without.supervision()?.api.args[0]).toBe(join(ROOT, 'tools/dev/entry/enterprise-entry.mjs'));
    expect(without.supervision()?.api.args[1]).toBe(join(ROOT, 'services/api/dist/main.js'));
    expect(without.supervision()?.api.env).not.toHaveProperty('NEBURYX_PROFILE');

    const preview = rig({ env: { NEBURYX_PROFILE: 'enterprise', NEBURYX_SECRET: 'not passed' } });
    await up(preview.deps);
    expect(preview.calls.at(-1)?.options.env).toMatchObject({ NEBURYX_PROFILE: 'enterprise', NEBURYX_CONFIG: MAPPING });
    expect(JSON.stringify(preview.calls.at(-1)?.options.env)).not.toContain('not passed');
    const given = preview.supervision();
    expect(given?.api.env['NEBURYX_PROFILE']).toBe('enterprise');
    expect(JSON.stringify(given?.children.map((child) => child.env))).not.toContain('NEBURYX_PROFILE');
  });

  it('gives the migrate step and the API the two database limits when they are set, no other child, and the API a wait that outlasts the connect limit', async () => {
    const limits = { NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: '30000', NEBURYX_READINESS_LIMIT_MS: '8000', AWS_SECRET_ACCESS_KEY: 'a developer secret' };
    const run = rig({ env: limits });
    await up(run.deps);
    const migrate = run.calls.at(-1)?.options.env;
    expect(migrate).toMatchObject({ NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: '30000', NEBURYX_READINESS_LIMIT_MS: '8000' });
    expect(migrate).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(run.supervision()?.api.env).toMatchObject({ NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: '30000', NEBURYX_READINESS_LIMIT_MS: '8000' });
    expect(run.supervision()?.api.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(run.supervision()?.api.readyTimeoutMs).toBe(140_000);
    for (const build of run.calls.slice(0, -1)) expect(build.options.env).not.toHaveProperty('NEBURYX_DATABASE_CONNECT_TIMEOUT_MS');
    const plain = rig();
    await up(plain.deps);
    expect(plain.calls.at(-1)?.options.env).not.toHaveProperty('NEBURYX_DATABASE_CONNECT_TIMEOUT_MS');
    expect(plain.supervision()?.api.readyTimeoutMs).toBe(120_000);
  });

  it('does not give an empty profile to any child', async () => {
    const empty = rig({ env: { NEBURYX_PROFILE: '' } });
    await up(empty.deps);
    expect(JSON.stringify(empty.calls.at(-1)?.options.env)).not.toContain('NEBURYX_PROFILE');
    expect(empty.supervision()?.api.env).not.toHaveProperty('NEBURYX_PROFILE');
  });

  it('builds, migrates with the migration login, then supervises the compilers, the web dev server and the API', async () => {
    const { deps, calls, supervision } = rig();
    expect(await up(deps)).toBe(0);
    expect(calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1])).toEqual(BUILDS.map((build) => build.filter));
    expect(BUILDS.map((build) => build.filter)).toEqual(['@neburyx/contracts', '@neburyx/ee-audit', '@neburyx/ee-ask', '@neburyx/api', '@neburyx/web']);
    expect(calls.at(-1)?.args).toEqual([join(ROOT, 'tools/dev/entry/enterprise-entry.mjs'), join(ROOT, 'services/api/dist/cli.js'), 'migrate']);
    expect(calls.at(-1)?.options.env).toEqual({ PATH: '/bin', HOME, DATABASE_MIGRATION_URL: 'postgres://mig:MIGPW@elsewhere.example.test/x', DATABASE_APP_ROLE: 'x_app' });
    const given = supervision();
    expect(given?.children.map((child) => child.name)).toEqual(['the contracts compiler', 'the API compiler', 'the web dev server']);
    expect(given?.children[0]?.args.join(' ')).toContain('-p tsconfig.build.json --watch');
    const web = given?.children.find((child) => child.name === 'the web dev server');
    expect(web?.args).toContain('127.0.0.1');
    expect(web?.env['NEBURYX_DEV_API_URL']).toBe('http://127.0.0.1:4000');
    expect(given?.api.healthUrl).toBe('http://127.0.0.1:4000/healthz');
    expect(given?.api.watch).toEqual([join(ROOT, 'services/api/dist'), join(ROOT, 'packages/contracts/dist')]);
  });

  it('gives the API the app login, the mapping, the logins and one cursor key, and neither the migration login nor a demo login', async () => {
    const { deps, supervision } = rig();
    await up(deps);
    const api = supervision()?.api.env ?? {};
    expect(api).toMatchObject({ DATABASE_URL: 'postgres://app:APPPW@elsewhere.example.test/x', NEBURYX_CONFIG: MAPPING, NEBURYX_HOST: '127.0.0.1', OWN_USER: 'readerlogin', OWN_PASSWORD: 'loginsecret', OWN_URI: 'bolt://10.0.0.9:7687' });
    expect(Buffer.from(api['NEBURYX_CURSOR_KEY'] ?? '', 'base64')).toHaveLength(32);
    expect(JSON.stringify(api)).not.toMatch(/MIGPW|DATABASE_MIGRATION_URL|DEMO_NEO4J/);
  });

  it('gives the logins to the API and to no other process', async () => {
    const { deps, calls, supervision } = rig();
    await up(deps);
    const others = [...calls.map((call) => call.options.env ?? {}), ...(supervision()?.children.map((child) => child.env) ?? [])];
    expect(others.length).toBeGreaterThan(5);
    for (const env of others) for (const value of ['readerlogin', 'loginsecret', '10.0.0.9', 'APPPW']) expect(JSON.stringify(env)).not.toContain(value);
    for (const call of calls) for (const value of VALUES) expect(JSON.stringify(call.args)).not.toContain(value);
  });

  it('prints no login, address, connection string or password, and does not mention containers or demo sources', async () => {
    const output: string[] = [];
    const { deps } = rig();
    await up({ ...deps, out: (text) => void output.push(text) });
    const text = output.join('\n');
    for (const value of VALUES) expect(text).not.toContain(value);
    expect(text).not.toMatch(/dev:down|container|demo|synthetic|Community/i);
    expect(text).toContain('does not check that their logins are read-only');
  });

  it('lets the environment win over the file', async () => {
    const { deps, calls, supervision } = rig({ env: { NEBURYX_DEV_DATABASE_APP_ROLE: 'role_from_env', NEBURYX_DEV_DATABASE_URL: 'postgres://env-app/x' } });
    await up(deps);
    expect(calls.at(-1)?.options.env).toMatchObject({ DATABASE_APP_ROLE: 'role_from_env' });
    expect(supervision()?.api.env['DATABASE_URL']).toBe('postgres://env-app/x');
  });

  it('reads the file NEBURYX_DEV_CONFIG names', async () => {
    const { deps, reads } = rig({ files: { '/elsewhere/dev.env': SETTINGS_TEXT, [MAPPING]: 'x', [LOGINS]: LOGIN_TEXT }, env: { NEBURYX_DEV_CONFIG: '/elsewhere/dev.env' } });
    expect(await up(deps)).toBe(0);
    expect(reads[0]).toBe('/elsewhere/dev.env');
  });
});

describe('a start that cannot go ahead', () => {
  const bad: [string, Parameters<typeof rig>[0], new (...args: never[]) => Error][] = [
    ['no settings file', { files: { [MAPPING]: 'x', [LOGINS]: LOGIN_TEXT } }, ConfigUnusable],
    ['a missing key', { files: { [SETTINGS]: SETTINGS_TEXT.replace(/NEBURYX_DEV_DATABASE_APP_ROLE=.*\n/, ''), [MAPPING]: 'x', [LOGINS]: LOGIN_TEXT } }, ConfigUnusable],
    ['a settings file wider than 0600', { modes: { [SETTINGS]: 0o644 } }, ConfigUnusable],
    ['a login file wider than 0600', { modes: { [LOGINS]: 0o640 } }, MappingUnusable],
    ['a mapping that does not exist', { files: { [SETTINGS]: SETTINGS_TEXT, [LOGINS]: LOGIN_TEXT } }, MappingUnusable],
    ['a login file that sets a name the tool sets itself', { files: { [SETTINGS]: SETTINGS_TEXT, [MAPPING]: 'x', [LOGINS]: 'DATABASE_URL=loginsecret\n' } }, MappingUnusable],
  ];

  it.each(bad)('stops for %s before it locks, runs, picks a port or supervises anything, and shows no value', async (_name, options, kind) => {
    const { deps, calls, ports, supervision } = rig(options);
    const lockFolder = deps.lock.folder ?? '';
    const error: unknown = await up(deps).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(kind);
    for (const value of VALUES) expect(error instanceof Error ? error.message : '').not.toContain(value);
    expect(calls).toEqual([]);
    expect(ports).toEqual([]);
    expect(supervision()).toBeUndefined();
    expect(readdirSync(lockFolder)).toEqual([]);
  });

  it.each([
    ['a build', (call: Call) => call.args.includes('@neburyx/api')],
    ['the migration', (call: Call) => call.args.at(-1) === 'migrate'],
  ])('stops before the API starts when %s fails', async (_name, fail) => {
    const { deps, supervision } = rig({ fail });
    await expect(up(deps)).rejects.toBeInstanceOf(Error);
    expect(supervision()).toBeUndefined();
  });
});

describe('no container, ever', () => {
  async function stopsWhileRunning() {
    let stopNow: () => void = () => undefined;
    const stopRequested = new Promise<void>((resolve) => {
      stopNow = resolve;
    });
    const first = rig();
    const slowRun: Run = async (command, args, options = {}) => {
      await first.deps.run(command, args, options);
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { code: 130, stdout: '', stderr: '' };
    };
    const output: string[] = [];
    const running = up({ ...first.deps, run: slowRun, stopRequested, out: (text) => void output.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopNow();
    return { code: await running, first, output };
  }

  it('makes no docker call on a normal start', async () => {
    const { deps, calls } = rig();
    await up(deps);
    expect(calls.length).toBeGreaterThan(0);
    expect(dockerCalls(calls)).toEqual([]);
    expect(calls.every((call) => ['pnpm', '/node'].includes(call.command))).toBe(true);
  });

  it('makes no docker call when a step fails', async () => {
    const { deps, calls } = rig({ fail: (call) => call.args.at(-1) === 'migrate' });
    await up(deps).catch(() => undefined);
    expect(dockerCalls(calls)).toEqual([]);
  });

  it('makes no docker call when Ctrl-C comes during a step, and says only that it stopped', async () => {
    const { code, first, output } = await stopsWhileRunning();
    expect(code).toBe(0);
    expect(first.calls).toHaveLength(1);
    expect(output).toEqual(['stopped']);
    expect(dockerCalls(first.calls)).toEqual([]);
  });

  it('makes no docker call when the settings are unusable', async () => {
    const { deps, calls } = rig({ files: {} });
    await up(deps).catch(() => undefined);
    expect(dockerCalls(calls)).toEqual([]);
  });

  it('has no source file that names docker or compose', () => {
    const folder = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((name) => /\.(ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name));
    expect(sources.length).toBeGreaterThan(5);
    for (const name of sources) expect(readFileSync(join(folder, name), 'utf8'), name).not.toMatch(/docker|compose/i);
  });

  it('has no root script or file in the tool for the old container path', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const scripts: Record<string, string> = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['dev']).toBe('pnpm --fail-if-no-match --filter "@neburyx/dev..." build && node tools/dev/dist/main.js');
    expect(scripts).not.toHaveProperty('dev:down');
    expect(scripts['test:compose']).not.toContain('@neburyx/dev');
    expect(readdirSync(join(root, 'tools/dev')).filter((name) => /compose/i.test(name))).toEqual([]);
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
    release();
    await running;
    expect(await up({ ...second.deps, lock: { folder } })).toBe(0);
  });
});
