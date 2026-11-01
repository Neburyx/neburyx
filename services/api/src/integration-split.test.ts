import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config.js';
import composeConfig from '../vitest.compose.config.js';
import imageConfig from '../vitest.image.config.js';
import integrationConfig from '../vitest.integration.config.js';

describe('the unit and integration test configurations', () => {
  it('keeps integration tests out of the unit run', () => {
    expect(unitConfig.test?.exclude).toContain('**/*.integration.test.ts');
    expect(unitConfig.test?.exclude).toContain('**/*.image.test.ts');
    expect(unitConfig.test?.exclude).toContain('**/*.compose.test.ts');
  });

  it('runs only integration tests, one file at a time', () => {
    expect(integrationConfig.test?.include).toEqual(['src/**/*.integration.test.ts']);
    expect(integrationConfig.test?.fileParallelism).toBe(false);
  });

  it('runs only image tests, one file at a time, with long timeouts', () => {
    expect(imageConfig.test?.include).toEqual(['src/**/*.image.test.ts']);
    expect(imageConfig.test?.fileParallelism).toBe(false);
    expect(imageConfig.test?.hookTimeout).toBeGreaterThanOrEqual(600_000);
  });

  it('runs only compose tests, one file at a time, with long timeouts', () => {
    expect(composeConfig.test?.include).toEqual(['src/**/*.compose.test.ts']);
    expect(composeConfig.test?.fileParallelism).toBe(false);
    expect(composeConfig.test?.hookTimeout).toBeGreaterThanOrEqual(600_000);
  });
});
