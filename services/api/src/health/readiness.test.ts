import { describe, expect, it } from 'vitest';
import { parseReadinessLimit, probeStepMs, readinessResponse, runReadiness } from './readiness.js';

const NO_SOURCES = { reachable: 0, unreachable: 0, unknown: 0 };
const NO_AUDIT = { written: 0, failed: 0, dropped: 0, queued: 0 };

describe('readinessResponse', () => {
  it('is ready with 200 only when every check is ok', () => {
    expect(readinessResponse({ database: 'ok', migrations: 'ok' }, NO_SOURCES, NO_AUDIT)).toEqual({ statusCode: 200, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: NO_SOURCES, audit: NO_AUDIT } });
    expect(readinessResponse({ database: 'ok', migrations: 'pending' }, NO_SOURCES, NO_AUDIT)).toEqual({
      statusCode: 503,
      body: { status: 'not_ready', checks: { database: 'ok', migrations: 'pending' }, sources: NO_SOURCES, audit: NO_AUDIT },
    });
  });

  it('does not let the sources change the status', () => {
    const down = { reachable: 0, unreachable: 3, unknown: 0 };
    expect(readinessResponse({ database: 'ok', migrations: 'ok' }, down, NO_AUDIT)).toEqual({ statusCode: 200, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: down, audit: NO_AUDIT } });
    expect(readinessResponse({ database: 'unreachable', migrations: 'unknown' }, down, NO_AUDIT).statusCode).toBe(503);
  });
});

describe('the audit counts of readinessResponse', () => {
  it('report the counters beside the checks and never change the status, however many events failed or were dropped', () => {
    const lossy = { written: 5, failed: 40, dropped: 900, queued: 1000 };
    expect(readinessResponse({ database: 'ok', migrations: 'ok' }, NO_SOURCES, lossy)).toEqual({ statusCode: 200, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: NO_SOURCES, audit: lossy } });
    expect(readinessResponse({ database: 'unreachable', migrations: 'unknown' }, NO_SOURCES, lossy).statusCode).toBe(503);
  });
});

describe('runReadiness', () => {
  const never = (): Promise<never> => new Promise(() => undefined);

  it('reports every check from the steps when they finish in time', async () => {
    expect(await runReadiness({ ping: () => Promise.resolve(), migrations: () => Promise.resolve('pending') }, 100)).toEqual({
      database: 'ok',
      migrations: 'pending',
    });
  });

  it('reports the database unreachable and the migrations unknown when the ping fails', async () => {
    expect(await runReadiness({ ping: () => Promise.reject(new Error('down')), migrations: () => Promise.resolve('ok') }, 100)).toEqual({
      database: 'unreachable',
      migrations: 'unknown',
    });
  });

  it('keeps the database ok and reports the migrations unknown when only the migration step runs out of time', async () => {
    const started = Date.now();
    const checks = await runReadiness({ ping: () => Promise.resolve(), migrations: never }, 50);
    expect(checks).toEqual({ database: 'ok', migrations: 'unknown' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports the database unreachable when the ping itself runs out of time', async () => {
    expect(await runReadiness({ ping: never, migrations: () => Promise.resolve('ok') }, 50)).toEqual({
      database: 'unreachable',
      migrations: 'unknown',
    });
  });

  it('keeps the database ok when the migration step fails', async () => {
    expect(await runReadiness({ ping: () => Promise.resolve(), migrations: () => Promise.reject(new Error('x')) }, 100)).toEqual({
      database: 'ok',
      migrations: 'unknown',
    });
  });
});

describe('probeStepMs', () => {
  it.each([
    [2000, 1500],
    [500, 250],
    [60_000, 59_500],
  ])('is the step of a %i ms limit: %i ms', (limit, step) => {
    expect(probeStepMs(limit)).toBe(step);
  });
});

describe('parseReadinessLimit', () => {
  it('is 2 000 ms when absent or empty', () => {
    expect(parseReadinessLimit(undefined)).toBe(2000);
    expect(parseReadinessLimit('')).toBe(2000);
  });

  it.each(['500', '2000', '60000'])('accepts %s', (value) => {
    expect(parseReadinessLimit(value)).toBe(Number(value));
  });

  it.each(['499', '60001', '1e3', 'x', ' 2000'])('refuses %j', (value) => {
    expect(parseReadinessLimit(value)).toBeUndefined();
  });
});
