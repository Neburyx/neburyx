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
    expect(parseMigrateConfig({ DATABASE_MIGRATION_URL: value, DATABASE_APP_ROLE: 'app' })).toEqual({ url: value, appRole: 'app' });
  });
});
