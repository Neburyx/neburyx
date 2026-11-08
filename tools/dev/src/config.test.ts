import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, CONFIG_VARIABLE, ConfigUnusable, loadDevConfig } from './config.js';
import type { Files } from './files.js';

const HOME = '/home/dev';
const DEFAULT = `${HOME}/.config/neburyx/dev.env`;
const FILE_TEXT = [
  '# the settings of pnpm dev',
  'NEBURYX_DEV_MAPPING=/p/mapping.yaml',
  'NEBURYX_DEV_MAPPING_ENV="/p/logins.env"',
  'NEBURYX_DEV_DATABASE_URL=postgres://app:filesecret@db.example.test/x',
  'NEBURYX_DEV_DATABASE_MIGRATION_URL=postgres://mig:filesecret@db.example.test/x',
  'NEBURYX_DEV_DATABASE_APP_ROLE=x_app',
  '',
].join('\n');
const SECRETS = ['filesecret', 'db.example.test', 'envsecret'];

function rig(state: Record<string, string>, modes: Record<string, number> = {}) {
  const reads: string[] = [];
  const files: Files = {
    exists: (path) => path in state,
    read: (path) => (reads.push(path), state[path] ?? ''),
    mode: (path) => modes[path] ?? 0o600,
  };
  return { files, reads };
}

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (caught) {
    if (caught instanceof Error) return caught;
  }
  throw new Error('did not throw');
}

describe('the settings file of pnpm dev', () => {
  it('is read from ~/.config/neburyx/dev.env by default, with comments and quotes handled', () => {
    const { files } = rig({ [DEFAULT]: FILE_TEXT });
    expect(loadDevConfig({ HOME }, files)).toEqual({
      NEBURYX_DEV_MAPPING: '/p/mapping.yaml',
      NEBURYX_DEV_MAPPING_ENV: '/p/logins.env',
      NEBURYX_DEV_DATABASE_URL: 'postgres://app:filesecret@db.example.test/x',
      NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://mig:filesecret@db.example.test/x',
      NEBURYX_DEV_DATABASE_APP_ROLE: 'x_app',
    });
  });

  it('is read from the file NEBURYX_DEV_CONFIG names, and the default file is then left alone', () => {
    const { files, reads } = rig({ '/elsewhere/dev.env': FILE_TEXT, [DEFAULT]: 'broken' });
    expect(loadDevConfig({ HOME, [CONFIG_VARIABLE]: '/elsewhere/dev.env' }, files).NEBURYX_DEV_DATABASE_APP_ROLE).toBe('x_app');
    expect(reads).toEqual(['/elsewhere/dev.env']);
  });

  it('lets a value in the environment win over the file, and an empty one not', () => {
    const { files } = rig({ [DEFAULT]: FILE_TEXT });
    const config = loadDevConfig({ HOME, NEBURYX_DEV_DATABASE_APP_ROLE: 'from_env', NEBURYX_DEV_MAPPING: '' }, files);
    expect(config.NEBURYX_DEV_DATABASE_APP_ROLE).toBe('from_env');
    expect(config.NEBURYX_DEV_MAPPING).toBe('/p/mapping.yaml');
  });

  it('accepts a file that fills only some keys when the environment fills the rest', () => {
    const { files } = rig({ [DEFAULT]: 'NEBURYX_DEV_MAPPING=/p/m.yaml\n' });
    const env = { HOME, NEBURYX_DEV_MAPPING_ENV: '/p/l.env', NEBURYX_DEV_DATABASE_URL: 'u', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'm', NEBURYX_DEV_DATABASE_APP_ROLE: 'r' };
    expect(loadDevConfig(env, files).NEBURYX_DEV_MAPPING).toBe('/p/m.yaml');
  });

  it('stops when the default file is missing, even when the environment holds every key, and names the file', () => {
    const { files } = rig({});
    const env = Object.fromEntries(CONFIG_KEYS.map((key) => [key, '/x']));
    const error = failure(() => loadDevConfig({ HOME, ...env }, files));
    expect(error).toBeInstanceOf(ConfigUnusable);
    expect(error.message).toContain(DEFAULT);
    expect(error.message).toContain('does not exist');
  });

  it('stops when the file NEBURYX_DEV_CONFIG names is missing, and names it', () => {
    const { files } = rig({ [DEFAULT]: FILE_TEXT });
    const error = failure(() => loadDevConfig({ HOME, [CONFIG_VARIABLE]: '/elsewhere/dev.env' }, files));
    expect(error.message).toContain('/elsewhere/dev.env');
  });

  it.each(CONFIG_KEYS)('stops when %s is in neither the file nor the environment, naming it and no value', (missing) => {
    const text = FILE_TEXT.split('\n').filter((line) => !line.startsWith(`${missing}=`)).join('\n');
    const { files } = rig({ [DEFAULT]: text });
    const error = failure(() => loadDevConfig({ HOME, NEBURYX_DEV_NOTHING: 'envsecret' }, files));
    expect(error).toBeInstanceOf(ConfigUnusable);
    expect(error.message).toContain(missing);
    for (const secret of SECRETS) expect(error.message).not.toContain(secret);
  });

  it('names every missing key when the file is empty, and treats an empty value as missing', () => {
    const error = failure(() => loadDevConfig({ HOME }, rig({ [DEFAULT]: 'NEBURYX_DEV_DATABASE_URL=\n' }).files));
    for (const key of CONFIG_KEYS) expect(error.message).toContain(key);
  });

  it('refuses a key it does not know, by name, so a typo is not reported as a missing key', () => {
    const { files } = rig({ [DEFAULT]: `${FILE_TEXT}NEBURYX_DEV_DATABSE_URL=envsecret\n` });
    const error = failure(() => loadDevConfig({ HOME }, files));
    expect(error.message).toContain('NEBURYX_DEV_DATABSE_URL');
    expect(error.message).not.toContain('envsecret');
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666, 0o700, 0o755])('refuses a file with mode %o, before reading it, and shows no value', (mode) => {
    const { files, reads } = rig({ [DEFAULT]: FILE_TEXT }, { [DEFAULT]: mode });
    const error = failure(() => loadDevConfig({ HOME }, files));
    expect(error.message).toContain('chmod 600');
    expect(error.message).toContain(DEFAULT);
    expect(reads).toEqual([]);
    for (const secret of SECRETS) expect(error.message).not.toContain(secret);
  });

  it.each([0o600, 0o400])('accepts a file with mode %o', (mode) => {
    const { files } = rig({ [DEFAULT]: FILE_TEXT }, { [DEFAULT]: mode });
    expect(loadDevConfig({ HOME }, files).NEBURYX_DEV_DATABASE_APP_ROLE).toBe('x_app');
  });

  it('requires NEBURYX_DEV_CONFIG to be an absolute path', () => {
    const error = failure(() => loadDevConfig({ HOME, [CONFIG_VARIABLE]: 'dev.env' }, rig({ 'dev.env': FILE_TEXT }).files));
    expect(error.message).toContain(CONFIG_VARIABLE);
  });

  it.each([[{}], [{ HOME: '' }], [{ HOME: 'relative' }]])('says what is wrong when there is no usable HOME and no NEBURYX_DEV_CONFIG (%j)', (env) => {
    const error = failure(() => loadDevConfig(env, rig({}).files));
    expect(error.message).toContain('HOME');
    expect(error.message).toContain(CONFIG_VARIABLE);
  });
});
