import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
