import { describe, expect, it } from 'vitest';
import { apiEnvironment, baseEnvironment, demoLogins, dockerEnvironment, migrationEnvironment, webEnvironment } from './environments.js';
import { generateSettings } from './settings.js';

const developer = { PATH: '/bin', HOME: '/home/dev', TMPDIR: '/tmp', NODE_ENV: 'development', LANG: 'C', DOCKER_HOST: 'unix:///sock', AWS_SECRET_ACCESS_KEY: 'a developer secret', DATABASE_URL: 'postgres://elsewhere', NEBURYX_DB_ADMIN_PASSWORD: 'inherited' };
const settings = generateSettings();

describe('the environments of the children', () => {
  it('give every child only a short list of the developer variables', () => {
    expect(Object.keys(baseEnvironment(developer)).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
    expect(Object.keys(dockerEnvironment(developer)).sort()).toEqual(['DOCKER_HOST', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  });

  it('give migrate the migration URL and the app role and none of the other settings', () => {
    const env = migrationEnvironment(baseEnvironment(developer), 'postgres://migrate', 'neburyx_app');
    expect(env['DATABASE_MIGRATION_URL']).toBe('postgres://migrate');
    expect(env['DATABASE_APP_ROLE']).toBe('neburyx_app');
    for (const forbidden of ['DATABASE_URL', 'NEBURYX_CURSOR_KEY', 'DEMO_NEO4J_PASSWORD', 'NEBURYX_DB_ADMIN_PASSWORD', 'AWS_SECRET_ACCESS_KEY']) expect(env, forbidden).not.toHaveProperty(forbidden);
  });

  it('give the API the app URL, the loopback address, the cursor key and the demo login, and neither the administrator nor the migration password', () => {
    const env = apiEnvironment(baseEnvironment(developer), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', settings, sourceLogins: demoLogins(settings) });
    expect(env).toMatchObject({ DATABASE_URL: 'postgres://app', NEBURYX_CONFIG: '/m.yaml', NEBURYX_HOST: '127.0.0.1', NEBURYX_PORT: '4100', NEBURYX_WEB_ROOT: '/web', NEBURYX_CURSOR_KEY: settings.NEBURYX_CURSOR_KEY, DEMO_NEO4J_USER: 'neo4j', DEMO_NEO4J_PASSWORD: settings.DEMO_NEO4J_PASSWORD });
    const text = JSON.stringify(env);
    for (const forbidden of [settings.NEBURYX_DB_ADMIN_PASSWORD, settings.NEBURYX_DB_MIGRATION_PASSWORD, 'DATABASE_MIGRATION_URL', 'DATABASE_APP_ROLE', 'inherited', 'a developer secret', 'elsewhere']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('keep the loopback binding even when the developer sets another host', () => {
    const env = apiEnvironment(baseEnvironment({ ...developer, NEBURYX_HOST: '0.0.0.0' }), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', settings, sourceLogins: demoLogins(settings) });
    expect(env['NEBURYX_HOST']).toBe('127.0.0.1');
  });

  it('give the API the logins of a mapping of your own in place of the demo login, and let none of them replace a fixed value', () => {
    const logins = { OWN_USER: 'reader', OWN_PASSWORD: 'a login value', DATABASE_URL: 'postgres://other', NEBURYX_CONFIG: '/other.yaml', NEBURYX_HOST: '0.0.0.0' };
    const env = apiEnvironment(baseEnvironment(developer), { databaseUrl: 'postgres://app', mappingPath: '/m.yaml', port: 4100, webRoot: '/web', settings, sourceLogins: logins });
    expect(env).toMatchObject({ OWN_USER: 'reader', OWN_PASSWORD: 'a login value', DATABASE_URL: 'postgres://app', NEBURYX_CONFIG: '/m.yaml', NEBURYX_HOST: '127.0.0.1' });
    expect(env).not.toHaveProperty('DEMO_NEO4J_USER');
    expect(env).not.toHaveProperty('DEMO_NEO4J_PASSWORD');
  });

  it('tell the web dev server where the API is', () => {
    expect(webEnvironment(baseEnvironment(developer), 'http://127.0.0.1:4100')['NEBURYX_DEV_API_URL']).toBe('http://127.0.0.1:4100');
  });
});
