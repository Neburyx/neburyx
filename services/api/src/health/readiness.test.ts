import { describe, expect, it } from 'vitest';
import { readinessResponse, runReadiness } from './readiness.js';

describe('readinessResponse', () => {
  it('is ready with 200 only when every check is ok', () => {
    expect(readinessResponse({ database: 'ok', migrations: 'ok' })).toEqual({ statusCode: 200, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' } } });
    expect(readinessResponse({ database: 'ok', migrations: 'pending' })).toEqual({
      statusCode: 503,
      body: { status: 'not_ready', checks: { database: 'ok', migrations: 'pending' } },
    });
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
