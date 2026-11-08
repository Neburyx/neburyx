import { describe, expect, it } from 'vitest';
import type { DevConfig } from './config.js';
import type { Files } from './files.js';
import { devMapping, MappingUnusable } from './mapping.js';

const MAPPING = '/private/m.yaml';
const LOGINS = '/private/logins.env';

function files(state: Record<string, string>, modes: Record<string, number> = {}): Files {
  return { exists: (path) => path in state, read: (path) => state[path] ?? '', mode: (path) => modes[path] ?? 0o600 };
}

const present = files({ [MAPPING]: 'sources: []', [LOGINS]: 'OWN_USER=reader\nOWN_PASSWORD="quoted secret"\n' });
const BOTH: DevConfig = { NEBURYX_DEV_MAPPING: MAPPING, NEBURYX_DEV_MAPPING_ENV: LOGINS, NEBURYX_DEV_DATABASE_URL: 'postgres://a:b@127.0.0.1/x', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://c:d@127.0.0.1/x', NEBURYX_DEV_DATABASE_APP_ROLE: 'x_app' };

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (caught) {
    if (caught instanceof Error) return caught;
  }
  throw new Error('did not throw');
}

describe('the mapping of your own', () => {
  it('is the mapping path and the values of the env file when both are set', () => {
    expect(devMapping(BOTH, present)).toEqual({ mappingPath: MAPPING, logins: { OWN_USER: 'reader', OWN_PASSWORD: 'quoted secret' } });
  });

  it.each([['OWN_PASSWORD='], ['OWN_PASSWORD=""'], ["OWN_PASSWORD=''"], ['OWN_PASSWORD=   ']])('refuses a variable with an empty value (%s), naming it', (line) => {
    const error = failure(() => devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: `OWN_USER=reader\n${line}\n` })));
    expect(error).toBeInstanceOf(MappingUnusable);
    expect(error.message).toContain('OWN_PASSWORD');
    expect(error.message).toContain('empty');
    expect(error.message).not.toContain('reader');
  });

  it('refuses a relative path or one that does not exist', () => {
    expect(failure(() => devMapping({ ...BOTH, NEBURYX_DEV_MAPPING: 'm.yaml' }, present))).toBeInstanceOf(MappingUnusable);
    expect(failure(() => devMapping({ ...BOTH, NEBURYX_DEV_MAPPING_ENV: '~/logins.env' }, present))).toBeInstanceOf(MappingUnusable);
    const error = failure(() => devMapping({ ...BOTH, NEBURYX_DEV_MAPPING: '/private/none.yaml' }, present));
    expect(error.message).toContain('NEBURYX_DEV_MAPPING');
    expect(error.message).not.toContain('/private');
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o620, 0o666, 0o770, 0o700, 0o500])('refuses an env file with mode %o and shows none of it', (mode) => {
    const error = failure(() => devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: 'OWN_PASSWORD=quoted secret' }, { [LOGINS]: mode })));
    expect(error).toBeInstanceOf(MappingUnusable);
    expect(error.message).toContain('chmod 600');
    expect(error.message).toContain(`mode 0${mode.toString(8)}`);
    expect(error.message).not.toContain('/private');
    expect(error.message).not.toContain('quoted secret');
  });

  it.each([0o600, 0o400])('accepts an env file with mode %o', (mode) => {
    expect(devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: 'A=b' }, { [LOGINS]: mode })).logins).toEqual({ A: 'b' });
  });

  it('does not look at the mode of the mapping file, which holds no login', () => {
    expect(devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: 'A=b' }, { [MAPPING]: 0o644 })).logins).toEqual({ A: 'b' });
  });

  it.each([['DATABASE_URL'], ['NEBURYX_CONFIG'], ['NEBURYX_DB_ADMIN_PASSWORD'], ['PATH'], ['NODE_OPTIONS'], ['DEMO_NEO4J_PASSWORD']])('refuses an env file that sets %s, naming it and not its value', (name) => {
    const error = failure(() => devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: `${name}=thevalue\nOWN=1` })));
    expect(error).toBeInstanceOf(MappingUnusable);
    expect(error.message).toContain(name);
    expect(error.message).not.toContain('thevalue');
  });

  it('refuses an env file with no settings, and one with a name that is not a variable name', () => {
    expect(failure(() => devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: '# only a comment\n\nno equals here' })))).toBeInstanceOf(MappingUnusable);
    const error = failure(() => devMapping(BOTH, files({ [MAPPING]: 'x', [LOGINS]: 'a b=thevalue' })));
    expect(error).toBeInstanceOf(MappingUnusable);
    expect(error.message).not.toContain('thevalue');
  });
});
