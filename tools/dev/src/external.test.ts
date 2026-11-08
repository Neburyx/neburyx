import { describe, expect, it } from 'vitest';
import type { DevConfig } from './config.js';
import { externalDatabase } from './external.js';

describe('the external database', () => {
  it('is the three database settings of the config', () => {
    const config: DevConfig = { NEBURYX_DEV_MAPPING: '/m', NEBURYX_DEV_MAPPING_ENV: '/e', NEBURYX_DEV_DATABASE_URL: 'postgres://app', NEBURYX_DEV_DATABASE_MIGRATION_URL: 'postgres://migrate', NEBURYX_DEV_DATABASE_APP_ROLE: 'neburyx_dev_app' };
    expect(externalDatabase(config)).toEqual({ appUrl: 'postgres://app', migrationUrl: 'postgres://migrate', appRole: 'neburyx_dev_app' });
  });
});
