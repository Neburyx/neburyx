import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, USAGE, type CliDependencies } from './cli.js';
import type { Run } from './exec.js';
import { nodeFiles } from './files.js';
import { formatSettings, generateSettings } from './settings.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function rig(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-cli-'));
  const lockFolder = mkdtempSync(join(tmpdir(), 'dev-cli-lock-'));
  folders.push(root, lockFolder);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const calls: string[] = [];
  const errors: string[] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: CliDependencies = {
    root,
    run,
    env: { PATH: '/bin' },
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
  return { deps, root, calls, errors };
}

describe('the command', () => {
  it('prints the usage and exits 2 for anything but up or down', async () => {
    for (const argv of [[], ['sideways'], ['up', 'extra']]) {
      const { deps, errors, calls } = rig();
      expect(await main(argv, deps)).toBe(2);
      expect(errors).toEqual([USAGE]);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a damaged .env before any build or Docker command, names the key, and leaves the file as it was', async () => {
    const damaged = formatSettings(generateSettings()).replace(/DEMO_NEO4J_PASSWORD=.*/, 'DEMO_NEO4J_PASSWORD=short');
    const { deps, root, calls, errors } = rig({ '.env': damaged });
    expect(await main(['up'], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('DEMO_NEO4J_PASSWORD');
    expect(errors.join('\n')).not.toContain('short');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(damaged);
  });

  it('exits 1 with a short message for an unexpected error and prints nothing of it', async () => {
    const { deps, errors } = rig();
    const failing: CliDependencies = {
      ...deps,
      random: () => {
        throw new Error('a secret detail');
      },
    };
    expect(await main(['up'], failing)).toBe(1);
    expect(errors).toEqual(['dev: an unexpected error stopped the command']);
  });

  it('refuses a mapping setting without its env file, and a real env file wider than 0600, with a message naming the problem and no value', async () => {
    const { deps, root, calls, errors } = rig({ 'logins.env': 'OWN_PASSWORD=loginsecret\n', 'm.yaml': 'sources: []\n' });
    const logins = join(root, 'logins.env');
    expect(await main(['up'], { ...deps, env: { PATH: '/bin', NEBURYX_DEV_MAPPING: join(root, 'm.yaml') } })).toBe(1);
    expect(errors.join('\n')).toContain('missing: NEBURYX_DEV_MAPPING_ENV');
    chmodSync(logins, 0o640);
    errors.length = 0;
    expect(await main(['up'], { ...deps, env: { PATH: '/bin', NEBURYX_DEV_MAPPING: join(root, 'm.yaml'), NEBURYX_DEV_MAPPING_ENV: logins } })).toBe(1);
    expect(errors.join('\n')).toContain('chmod 600');
    expect(errors.join('\n')).not.toContain('loginsecret');
    expect(calls).toEqual([]);
  });

  describe('an env file of a mapping of your own, on a real filesystem', () => {
    function own(logins: { mode: number; link?: 'good' | 'wide' | 'dangling' }) {
      const made = rig({ 'real.env': 'OWN_PASSWORD=loginsecret\n', 'm.yaml': 'sources: []\n' });
      chmodSync(join(made.root, 'real.env'), logins.mode);
      let target = join(made.root, 'real.env');
      if (logins.link !== undefined) {
        target = join(made.root, 'link.env');
        symlinkSync(logins.link === 'dangling' ? join(made.root, 'nothing.env') : join(made.root, 'real.env'), target);
      }
      const env = { PATH: '/bin', NEBURYX_DEV_MAPPING: join(made.root, 'm.yaml'), NEBURYX_DEV_MAPPING_ENV: target, NEBURYX_DEV_DATABASE_URL: 'postgres://a:b@127.0.0.1/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://c:d@127.0.0.1/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'x_app' };
      return { ...made, env };
    }

    it.each([0o600, 0o400])('accepts a file with mode %o and goes on to build', async (mode) => {
      const { deps, env, calls, errors } = own({ mode });
      const code = await main(['up'], { ...deps, env });
      expect({ code, errors }).toEqual({ code: 0, errors: [] });
      expect(calls.some((call) => call.includes('--filter'))).toBe(true);
      expect(calls.some((call) => call.startsWith('docker'))).toBe(false);
    });

    it('accepts a symlink to a file with mode 0600, judging the file it points to', async () => {
      const { deps, env, errors } = own({ mode: 0o600, link: 'good' });
      const code = await main(['up'], { ...deps, env });
      expect({ code, errors }).toEqual({ code: 0, errors: [] });
    });

    it('refuses a symlink to a file with mode 0644', async () => {
      const { deps, env, calls, errors } = own({ mode: 0o644, link: 'wide' });
      expect(await main(['up'], { ...deps, env })).toBe(1);
      expect(errors.join('\n')).toContain('wider than 0600');
      expect(errors.join('\n')).not.toContain('loginsecret');
      expect(calls).toEqual([]);
    });

    it('refuses a symlink that points to nothing as a file that does not exist', async () => {
      const { deps, env, calls, errors } = own({ mode: 0o600, link: 'dangling' });
      expect(await main(['up'], { ...deps, env })).toBe(1);
      expect(errors.join('\n')).toContain('does not exist');
      expect(calls).toEqual([]);
    });
  });
});
