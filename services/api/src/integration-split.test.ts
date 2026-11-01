import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config.js';
import integrationConfig from '../vitest.integration.config.js';

describe('the unit and integration test configurations', () => {
  it('keeps integration tests out of the unit run', () => {
    expect(unitConfig.test?.exclude).toContain('**/*.integration.test.ts');
  });

  it('runs only integration tests, one file at a time', () => {
    expect(integrationConfig.test?.include).toEqual(['src/**/*.integration.test.ts']);
    expect(integrationConfig.test?.fileParallelism).toBe(false);
  });
});
