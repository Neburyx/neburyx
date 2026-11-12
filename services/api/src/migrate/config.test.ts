import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { parseMigrateConfig } from './config.js';

describe('parseMigrateConfig', () => {
  it.each([undefined, '', 'not a url', 'mysql://user:secret@host/db', 'http://host/db', 'postgres'])(
    'rejects the migration URL %j naming only the key',
    (value) => {
      const failure = (): unknown => parseMigrateConfig({ DATABASE_MIGRATION_URL: value, DATABASE_APP_ROLE: 'app' });
      expect(failure).toThrow(ConfigError);
      expect(failure).toThrow('DATABASE_MIGRATION_URL');
      if (value !== undefined && value.length > 0) expect(failure).not.toThrow(value);
    },
  );

  it.each([undefined, ''])('rejects the app role %j naming only the key', (value) => {
    const failure = (): unknown => parseMigrateConfig({ DATABASE_MIGRATION_URL: 'postgres://u:p@h/db', DATABASE_APP_ROLE: value });
    expect(failure).toThrow(ConfigError);
    expect(failure).toThrow('DATABASE_APP_ROLE');
    expect(failure).not.toThrow('DATABASE_MIGRATION_URL');
  });

  it('names both keys when both are missing', () => {
    expect(() => parseMigrateConfig({})).toThrow('invalid configuration: DATABASE_MIGRATION_URL, DATABASE_APP_ROLE');
  });

  it.each(['postgres://user:secret@localhost:5432/db', 'postgresql://user@host/db'])('accepts %s', (value) => {
    expect(parseMigrateConfig({ DATABASE_MIGRATION_URL: value, DATABASE_APP_ROLE: 'app' })).toEqual({ url: value, appRole: 'app', connectTimeoutMs: 10_000 });
  });

  it('uses the connect limit that is set', () => {
    expect(parseMigrateConfig({ DATABASE_MIGRATION_URL: 'postgres://u:p@h/db', DATABASE_APP_ROLE: 'app', NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: '30000' }).connectTimeoutMs).toBe(30_000);
  });

  it.each(['abc', '999', '120001', '5.5'])('rejects the connect limit %j naming the key and not the value', (value) => {
    const failure = (): unknown => parseMigrateConfig({ DATABASE_MIGRATION_URL: 'postgres://u:p@h/db', DATABASE_APP_ROLE: 'app', NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: value });
    expect(failure).toThrow('invalid configuration: NEBURYX_DATABASE_CONNECT_TIMEOUT_MS');
    expect(failure).not.toThrow(value);
  });
});
