import { describe, expect, it } from 'vitest';
import { apiEnvironment, baseEnvironment, migrationEnvironment, webEnvironment } from './environments.js';

const developer = { PATH: '/bin', HOME: '/home/dev', TMPDIR: '/tmp', NODE_ENV: 'development', LANG: 'C', AWS_SECRET_ACCESS_KEY: 'a developer secret', DATABASE_URL: 'postgres://elsewhere', NEBURYX_DB_ADMIN_PASSWORD: 'inherited' };
const cursorKey = Buffer.alloc(32, 3).toString('base64');
const logins = { OWN_USER: 'reader', OWN_PASSWORD: 'a login value' };

describe('the environments of the children', () => {
  it('give every child only a short list of the developer variables', () => {
    expect(Object.keys(baseEnvironment(developer)).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  });

  it('give migrate the migration URL and the app role and none of the other settings', () => {
    const env = migrationEnvironment(baseEnvironment(developer), 'postgres://migrate', 'neburyx_app');
    expect(env['DATABASE_MIGRATION_URL']).toBe('postgres://migrate');
    expect(env['DATABASE_APP_ROLE']).toBe('neburyx_app');
    for (const forbidden of ['DATABASE_URL', 'NEBURYX_CURSOR_KEY', 'NEBURYX_DB_ADMIN_PASSWORD', 'AWS_SECRET_ACCESS_KEY']) expect(env, forbidden).not.toHaveProperty(forbidden);
  });

  it('give migrate the profile and the mapping path only when it is told to, and the API the profile only when one is set', () => {
    const migrate = migrationEnvironment(baseEnvironment(developer), 'postgres://migrate', 'neburyx_app', { profile: 'enterprise', mappingPath: '/m.yaml' });
    expect(migrate).toMatchObject({ NEBURYX_PROFILE: 'enterprise', NEBURYX_CONFIG: '/m.yaml' });
    expect(migrationEnvironment(baseEnvironment(developer), 'postgres://migrate', 'neburyx_app')).not.toHaveProperty('NEBURYX_PROFILE');
    const settings = { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', cursorKey, exportDirectory: '/tmp/exports', sourceLogins: logins };
    expect(apiEnvironment(baseEnvironment(developer), { ...settings, profile: 'enterprise' })['NEBURYX_PROFILE']).toBe('enterprise');
    expect(apiEnvironment(baseEnvironment(developer), settings)).not.toHaveProperty('NEBURYX_PROFILE');
  });

  it('give the API the app URL, the loopback address, the cursor key and the logins, and neither the administrator nor the migration password', () => {
    const env = apiEnvironment(baseEnvironment(developer), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', cursorKey, exportDirectory: '/tmp/exports', sourceLogins: logins });
    expect(env).toMatchObject({ DATABASE_URL: 'postgres://app', NEBURYX_CONFIG: '/m.yaml', NEBURYX_HOST: '127.0.0.1', NEBURYX_PORT: '4100', NEBURYX_WEB_ROOT: '/web', NEBURYX_CURSOR_KEY: cursorKey, NEBURYX_EXPORT_DIR: '/tmp/exports', ...logins });
    const text = JSON.stringify(env);
    for (const forbidden of ['DATABASE_MIGRATION_URL', 'DATABASE_APP_ROLE', 'inherited', 'a developer secret', 'elsewhere']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('keep the loopback binding even when the developer sets another host', () => {
    const env = apiEnvironment(baseEnvironment({ ...developer, NEBURYX_HOST: '0.0.0.0' }), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', cursorKey, exportDirectory: '/tmp/exports', sourceLogins: logins });
    expect(env['NEBURYX_HOST']).toBe('127.0.0.1');
  });

  it('let none of the logins replace a fixed value', () => {
    const hostile = { OWN_USER: 'reader', DATABASE_URL: 'postgres://other', NEBURYX_CONFIG: '/other.yaml', NEBURYX_HOST: '0.0.0.0' };
    const env = apiEnvironment(baseEnvironment(developer), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', cursorKey, exportDirectory: '/tmp/exports', sourceLogins: hostile });
    expect(env).toMatchObject({ OWN_USER: 'reader', DATABASE_URL: 'postgres://app', NEBURYX_CONFIG: '/m.yaml', NEBURYX_HOST: '127.0.0.1' });
  });

  it('tell the web dev server where the API is', () => {
    expect(webEnvironment(baseEnvironment(developer), 'http://127.0.0.1:4100')['NEBURYX_DEV_API_URL']).toBe('http://127.0.0.1:4100');
  });
});
