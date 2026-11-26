import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, USAGE, type CliDependencies } from './cli.js';
import type { Run } from './exec.js';
import { nodeFiles } from './files.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A real home folder with a settings file, a mapping and a login file, all in the shape pnpm dev expects. */
function rig(options: { settingsMode?: number; loginsMode?: number; settings?: (paths: { mapping: string; logins: string }) => string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dev-cli-home-'));
  const lockFolder = mkdtempSync(join(tmpdir(), 'dev-cli-lock-'));
  const repository = mkdtempSync(join(tmpdir(), 'dev-cli-repo-'));
  folders.push(home, lockFolder, repository);
  const mapping = join(home, 'm.yaml');
  const logins = join(home, 'real.env');
  writeFileSync(mapping, 'sources: []\n');
  writeFileSync(logins, 'OWN_PASSWORD=loginsecret\n');
  chmodSync(logins, options.loginsMode ?? 0o600);
  mkdirSync(join(home, '.config/neburyx'), { recursive: true });
  const settings = join(home, '.config/neburyx/dev.env');
  const text = options.settings?.({ mapping, logins }) ?? [`NEBURYX_DEV_MAPPING=${mapping}`, `NEBURYX_DEV_MAPPING_ENV=${logins}`, 'NEBURYX_DEV_DATABASE_URL=postgres://a:b@127.0.0.1/x', 'NEBURYX_DEV_DATABASE_MIGRATION_URL=postgres://c:d@127.0.0.1/x', 'NEBURYX_DEV_DATABASE_APP_ROLE=x_app', ''].join('\n');
  writeFileSync(settings, text);
  chmodSync(settings, options.settingsMode ?? 0o600);
  const calls: string[] = [];
  const errors: string[] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: CliDependencies = {
    root: repository,
    run,
    env: { PATH: '/bin', HOME: home },
    out: () => undefined,
    err: (text) => void errors.push(text),
    random: (bytes) => Buffer.alloc(bytes, 5),
    files: nodeFiles,
    nodePath: process.execPath,
    freePort: async () => 4000,
    supervise: async () => 0,
    stopRequested: new Promise<void>(() => undefined),
    lock: { folder: lockFolder },
  };
  return { deps, home, calls, errors, logins };
}

describe('the command', () => {
  it('prints the usage and exits 2 for any argument, a leftover up or down included', async () => {
    for (const argv of [['up'], ['down'], ['sideways'], ['up', 'extra']]) {
      const { deps, errors, calls } = rig();
      expect(await main(argv, deps)).toBe(2);
      expect(errors).toEqual([USAGE]);
      expect(calls).toEqual([]);
    }
  });

  it('starts from a real settings file of mode 0600 and builds with pnpm only', async () => {
    const { deps, calls, errors } = rig();
    expect({ code: await main([], deps), errors }).toEqual({ code: 0, errors: [] });
    expect(calls.some((call) => call.includes('--filter'))).toBe(true);
    expect(calls.every((call) => call.startsWith('pnpm ') || call.includes('migrate'))).toBe(true);
  });

  it('refuses a real settings file wider than 0600 before any command, naming the problem and no value', async () => {
    const { deps, calls, errors } = rig({ settingsMode: 0o644 });
    expect(await main([], deps)).toBe(1);
    expect(errors.join('\n')).toContain('chmod 600');
    expect(errors.join('\n')).not.toContain('x_app');
    expect(calls).toEqual([]);
  });

  it('refuses a login file wider than 0600 before any command, and shows no value of it', async () => {
    const { deps, calls, errors } = rig({ loginsMode: 0o640 });
    expect(await main([], deps)).toBe(1);
    expect(errors.join('\n')).toContain('wider than 0600');
    expect(errors.join('\n')).not.toContain('loginsecret');
    expect(calls).toEqual([]);
  });

  const settingsWith = (login: string, mapping: string): string => [`NEBURYX_DEV_MAPPING=${mapping}`, `NEBURYX_DEV_MAPPING_ENV=${login}`, 'NEBURYX_DEV_DATABASE_URL=u', 'NEBURYX_DEV_DATABASE_MIGRATION_URL=m', 'NEBURYX_DEV_DATABASE_APP_ROLE=r', ''].join('\n');

  it('judges a symlinked login file by the file it points to', async () => {
    const linked = rig({ settings: ({ mapping, logins }) => (symlinkSync(logins, `${logins}.link`), settingsWith(`${logins}.link`, mapping)) });
    expect(await main([], linked.deps)).toBe(0);
    const wide = rig({ loginsMode: 0o644, settings: ({ mapping, logins }) => (symlinkSync(logins, `${logins}.link`), settingsWith(`${logins}.link`, mapping)) });
    expect(await main([], wide.deps)).toBe(1);
    expect(wide.errors.join('\n')).toContain('wider than 0600');
    expect(wide.calls).toEqual([]);
  });

  it('treats a dangling symlink as a file that does not exist', async () => {
    const dangling = rig({ settings: ({ mapping, logins }) => (symlinkSync(`${logins}.nothing`, `${logins}.link`), settingsWith(`${logins}.link`, mapping)) });
    expect(await main([], dangling.deps)).toBe(1);
    expect(dangling.errors.join('\n')).toContain('does not exist');
    expect(dangling.calls).toEqual([]);
  });

  it('exits 1 with a message that names the missing file when the settings file does not exist, and starts nothing', async () => {
    const { deps, home, calls, errors } = rig();
    rmSync(join(home, '.config/neburyx/dev.env'));
    expect(await main([], deps)).toBe(1);
    expect(errors.join('\n')).toContain(join(home, '.config/neburyx/dev.env'));
    expect(calls).toEqual([]);
  });

  it('exits 1 with a short message for an unexpected error and prints nothing of it', async () => {
    const { deps, errors } = rig();
    const failing: CliDependencies = {
      ...deps,
      random: () => {
        throw new Error('a secret detail');
      },
    };
    expect(await main([], failing)).toBe(1);
    expect(errors).toEqual(['dev: an unexpected error stopped the command']);
  });

  it('dev:enterprise hands the AI settings file to the API under the shell, and plain dev ignores the file', async () => {
    const { deps, home } = rig();
    const ai = join(home, '.config/neburyx/dev-ai.env');
    writeFileSync(ai, ['NEBURYX_ASK_API_KEY_FILE=/keys/ask', 'NEBURYX_ASSISTANT_MAX_CALLS=7', 'NEBURYX_SUMMARY_MODEL=from-file', ''].join('\n'));
    chmodSync(ai, 0o600);
    const seen: Record<string, string>[] = [];
    const watching: CliDependencies = { ...deps, env: { ...deps.env, NEBURYX_SUMMARY_MODEL: 'from-shell' }, supervise: async (options) => (seen.push({ ...options.api.env }), 0) };
    expect(await main(['enterprise'], watching)).toBe(0);
    expect(seen[0]).toMatchObject({ NEBURYX_ASK_API_KEY_FILE: '/keys/ask', NEBURYX_ASSISTANT_MAX_CALLS: '7', NEBURYX_SUMMARY_MODEL: 'from-shell' });
    expect(await main([], watching)).toBe(0);
    expect(seen[1]).not.toHaveProperty('NEBURYX_ASK_API_KEY_FILE');
    expect(seen[1]).toMatchObject({ NEBURYX_SUMMARY_MODEL: 'from-shell' });
  });

  it('dev:enterprise refuses a missing, too-open or unknown-setting AI file before any command, naming the file and no value', async () => {
    const missing = rig();
    expect(await main(['enterprise'], missing.deps)).toBe(1);
    expect(missing.errors.join('\n')).toContain(join(missing.home, '.config/neburyx/dev-ai.env'));
    expect(missing.calls).toEqual([]);

    const open = rig();
    const openFile = join(open.home, '.config/neburyx/dev-ai.env');
    writeFileSync(openFile, 'NEBURYX_ASK_API_KEY=aisecret\n');
    chmodSync(openFile, 0o644);
    expect(await main(['enterprise'], open.deps)).toBe(1);
    expect(open.errors.join('\n')).toContain('wider than 0600');
    expect(open.calls).toEqual([]);

    const stray = rig();
    const strayFile = join(stray.home, '.config/neburyx/dev-ai.env');
    writeFileSync(strayFile, 'DATABASE_URL=postgres://x:aisecret@h/x\nNEBURYX_ASK_API_KEY=aisecret\n');
    chmodSync(strayFile, 0o600);
    expect(await main(['enterprise'], stray.deps)).toBe(1);
    expect(stray.errors.join('\n')).toContain('DATABASE_URL');
    expect(stray.calls).toEqual([]);

    for (const errors of [missing.errors, open.errors, stray.errors]) expect(errors.join('\n')).not.toContain('aisecret');
  });
});
