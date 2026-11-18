import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileExtension } from '@neburyx/contracts';
import { stringify } from 'yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const applied = vi.hoisted(() => ({ calls: [] as { eeDirectory?: string }[] }));
vi.mock('./run.js', () => ({ migrate: async (options: { eeDirectory?: string }) => (applied.calls.push({ ...(options.eeDirectory === undefined ? {} : { eeDirectory: options.eeDirectory }) }), { status: 'done', applied: [] }) }));

const { runMigrateCommand } = await import('./command.js');

const folder = mkdtempSync(join(tmpdir(), 'migrate-command-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
beforeEach(() => void (applied.calls.length = 0));

const DATABASE = { DATABASE_MIGRATION_URL: 'postgres://migrator@db.example.test:5432/neburyx', DATABASE_APP_ROLE: 'neburyx_app' };
const EE_FOLDER = '/not/read/ee-migrations';
const extension: ProfileExtension = { name: 'test', routeGroups: [], migrationsDirectory: EE_FOLDER };

function configFile(name: string, ai?: { preview: boolean }): string {
  const path = join(folder, name);
  writeFileSync(path, stringify({ sources: [], ...(ai === undefined ? {} : { ai }) }));
  return path;
}

async function run(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  let loaded = 0;
  const code = await runMigrateCommand({ ...DATABASE, ...env }, { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, directory: folder, extensionLoader: { load: async () => (loaded++, extension) } });
  return { code, err: err.join(''), loaded };
}

describe('the migrate command and the AI extension', () => {
  it('applies the extension migrations with a provider key alone, as the application would load the extension', async () => {
    const result = await run({ NEBURYX_ASK_API_KEY: 'not-a-real-key' });
    expect(result.code).toBe(0);
    expect(applied.calls).toEqual([{ eeDirectory: EE_FOLDER }]);
  });

  it('applies none with no provider or with all three features off, and applies them for the assistant alone', async () => {
    expect((await run({})).loaded).toBe(0);
    expect((await run({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_ENABLED: 'off', NEBURYX_SUMMARY_ENABLED: 'off', NEBURYX_ASSISTANT_ENABLED: 'off' })).loaded).toBe(0);
    expect(applied.calls).toEqual([{}, {}]);
    expect((await run({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_ENABLED: 'off', NEBURYX_SUMMARY_ENABLED: 'off' })).loaded).toBe(1);
    expect(applied.calls).toEqual([{}, {}, { eeDirectory: EE_FOLDER }]);
  });

  it('applies the extension migrations as before with the old switch on, key or no key', async () => {
    const config = configFile('on.yaml', { preview: true });
    await run({ NEBURYX_CONFIG: config, NEBURYX_PROFILE: 'enterprise' });
    await run({ NEBURYX_CONFIG: config, NEBURYX_PROFILE: 'enterprise', NEBURYX_ASK_API_KEY: 'k' });
    expect(applied.calls).toEqual([{ eeDirectory: EE_FOLDER }, { eeDirectory: EE_FOLDER }]);
  });

  it('refuses half of the old switch as before, and a bad flag with a provider, naming the setting and never the value', async () => {
    expect((await run({ NEBURYX_PROFILE: 'enterprise' })).code).toBe(1);
    const bad = await run({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_ENABLED: 'SENTINEL-FLAG' });
    expect([bad.code, bad.err]).toEqual([1, 'invalid configuration: NEBURYX_ASK_ENABLED must be on or off\n']);
    expect(applied.calls).toEqual([]);
  });
});
