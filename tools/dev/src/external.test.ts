import { describe, expect, it } from 'vitest';
import { externalDatabase, IncompleteExternalDatabase } from './external.js';

const ALL = { NEBURYX_DEV_DATABASE_URL: 'postgres://app:pw1@db.example.test/neburyx_dev', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://migrate:pw2@db.example.test/neburyx_dev', NEBURYX_DEV_DATABASE_APP_ROLE: 'neburyx_dev_app' };

describe('the external database', () => {
  it('is not used when none of the three variables is set', () => {
    expect(externalDatabase({})).toBeUndefined();
    expect(externalDatabase({ NEBURYX_DEV_DATABASE_URL: '' })).toBeUndefined();
  });

  it('is used when all three are set', () => {
    expect(externalDatabase(ALL)).toEqual({ appUrl: ALL.NEBURYX_DEV_DATABASE_URL, migrationUrl: ALL.NEBURYX_DEV_DATABASE_MIGRATION_URL, appRole: 'neburyx_dev_app' });
  });

  it.each([['NEBURYX_DEV_DATABASE_URL'], ['NEBURYX_DEV_DATABASE_MIGRATION_URL'], ['NEBURYX_DEV_DATABASE_APP_ROLE']])('refuses when only %s is missing, naming it and holding no value', (missing) => {
    const env: Record<string, string | undefined> = { ...ALL, [missing]: undefined };
    let error: unknown;
    try {
      externalDatabase(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IncompleteExternalDatabase);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain(`missing: ${missing}`);
    for (const secret of ['pw1', 'pw2', 'db.example.test']) expect(message).not.toContain(secret);
  });

  it('refuses when only one of the three is set', () => {
    expect(() => externalDatabase({ NEBURYX_DEV_DATABASE_APP_ROLE: 'neburyx_dev_app' })).toThrow(IncompleteExternalDatabase);
  });
});
