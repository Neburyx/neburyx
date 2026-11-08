import { describe, expect, it } from 'vitest';
import { baseSource, expectRefused, firstSource, load, type Json } from '../testing/mapping.js';
import { BUDGET_DEFAULTS } from './budgets.js';

describe('connection address', () => {
  it.each(['neo4j://host.example.test:7687', 'neo4j+s://host.example.test', 'neo4j+ssc://host.example.test:7687', 'bolt://host.example.test:7687', 'bolt+s://host.example.test', 'bolt+ssc://host.example.test'])(
    'accepts %s',
    (uri) => {
      expect(firstSource(load(baseSource({ uri }))).uri).toBe(uri);
    },
  );

  it.each([
    ['a scheme that is not supported', 'http://host.example.test', 'scheme'],
    ['no scheme', 'host.example.test:7687', 'scheme'],
    ['a missing host', 'neo4j://', 'host'],
    ['user-info', 'neo4j://reader:pw@host.example.test:7687', 'carries credentials'],
    ['a user name only', 'neo4j://reader@host.example.test:7687', 'carries credentials'],
  ])('refuses %s', (_name, uri, reason) => {
    expectRefused(baseSource({ uri }), 'sources[0].uri', reason);
  });
});

describe('authentication', () => {
  const auth = { kind: 'basic', username_env: 'DEMO_USER', password_env: 'DEMO_PASSWORD' };

  it.each([
    ['a kind that is not basic', { ...auth, kind: 'token' }, 'sources[0].auth.kind', 'must be one of'],
    ['a missing user name variable', { ...auth, username_env: undefined }, 'sources[0].auth.username_env', 'is required'],
    ['a missing password variable', { ...auth, password_env: undefined }, 'sources[0].auth.password_env', 'is required'],
    ['an invalid variable name', { ...auth, password_env: 'not valid' }, 'sources[0].auth.password_env', 'invalid format'],
    ['a variable name that starts with a digit', { ...auth, username_env: '1USER' }, 'sources[0].auth.username_env', 'invalid format'],
  ])('refuses %s', (_name, value, path, reason) => {
    expectRefused(baseSource({ auth: value }), path, reason);
  });
});

describe('the synthetic flag', () => {
  it('defaults to false and keeps true', () => {
    expect(firstSource(load(baseSource())).synthetic).toBe(false);
    expect(firstSource(load(baseSource({ synthetic: true }))).synthetic).toBe(true);
  });
});

describe('budgets', () => {
  const ranges: readonly [string, string, number, number][] = [
    ['timeout_ms', 'timeoutMs', 1, 10_000],
    ['max_page', 'maxPage', 1, 50],
    ['default_page', 'defaultPage', 10, 50],
    ['max_hops', 'maxHops', 1, 4],
    ['path_results_cap', 'pathResultsCap', 1, 25],
    ['user_concurrency', 'userConcurrency', 1, 8],
    ['source_concurrency', 'sourceConcurrency', 1, 256],
    ['queue_wait_ms', 'queueWaitMs', 1, 5000],
  ];

  it.each(ranges)('accepts %s at its minimum and its ceiling', (key, field, minimum, ceiling) => {
    for (const value of [minimum, ceiling]) {
      const budgets: Json = key === 'default_page' ? { default_page: value, max_page: 50 } : { [key]: value };
      expect(firstSource(load(baseSource({ budgets }))).budgets).toMatchObject({ [field]: value });
    }
  });

  it.each(ranges)('refuses %s below its minimum and above its ceiling', (key, _field, minimum, ceiling) => {
    expectRefused(baseSource({ budgets: { [key]: minimum - 1 } }), `sources[0].budgets.${key}`, `must be at least ${minimum}`);
    expectRefused(baseSource({ budgets: { [key]: ceiling + 1 } }), `sources[0].budgets.${key}`, `must be at most ${ceiling}`);
  });

  it('accepts a heavy-operation threshold of one and any larger integer', () => {
    expect(firstSource(load(baseSource({ budgets: { heavy_op_threshold: 1 } }))).budgets.heavyOpThreshold).toBe(1);
    expect(firstSource(load(baseSource({ budgets: { heavy_op_threshold: 100_000 } }))).budgets.heavyOpThreshold).toBe(100_000);
  });

  it('refuses a heavy-operation threshold of zero', () => {
    expectRefused(baseSource({ budgets: { heavy_op_threshold: 0 } }), 'sources[0].budgets.heavy_op_threshold', 'must be at least 1');
  });

  it('accepts a request rate of one and any larger whole number up to the safe-integer limit', () => {
    expect(firstSource(load(baseSource({ budgets: { requests_per_minute: 1 } }))).budgets.requestsPerMinute).toBe(1);
    expect(firstSource(load(baseSource({ budgets: { requests_per_minute: 1_000_000 } }))).budgets.requestsPerMinute).toBe(1_000_000);
    expect(firstSource(load(baseSource({ budgets: { requests_per_minute: Number.MAX_SAFE_INTEGER } }))).budgets.requestsPerMinute).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a request rate of zero, a negative one, a fraction, a string and one past the safe-integer limit', () => {
    const field = 'sources[0].budgets.requests_per_minute';
    expectRefused(baseSource({ budgets: { requests_per_minute: 0 } }), field, 'must be at least 1');
    expectRefused(baseSource({ budgets: { requests_per_minute: -5 } }), field, 'must be at least 1');
    expectRefused(baseSource({ budgets: { requests_per_minute: 2.5 } }), field, 'must be int');
    expectRefused(baseSource({ budgets: { requests_per_minute: 'many' } }), field, 'must be number');
    expectRefused(baseSource({ budgets: { requests_per_minute: Number.MAX_SAFE_INTEGER + 2 } }), field, 'must be at most 9007199254740991');
  });

  it('refuses a budget that is not an integer', () => {
    expectRefused(baseSource({ budgets: { max_hops: 2.5 } }), 'sources[0].budgets.max_hops', 'must be int');
    expectRefused(baseSource({ budgets: { max_hops: 'two' } }), 'sources[0].budgets.max_hops', 'must be number');
  });

  it('refuses an unknown budget key', () => {
    expectRefused(baseSource({ budgets: { burst: 5 } }), 'sources[0].budgets.burst', 'is not a known key');
  });

  it('refuses a default page above the maximum page', () => {
    expectRefused(baseSource({ budgets: { max_page: 20, default_page: 30 } }), 'sources[0].budgets.default_page', 'is above max_page (20)');
  });

  it('uses the defaults when budgets are omitted', () => {
    expect(firstSource(load(baseSource())).budgets).toEqual({
      timeoutMs: 5000,
      maxPage: 50,
      defaultPage: 25,
      maxHops: 4,
      pathResultsCap: 25,
      userConcurrency: 2,
      sourceConcurrency: 32,
      queueWaitMs: 2000,
      heavyOpThreshold: 500,
      requestsPerMinute: 120,
    });
    expect(BUDGET_DEFAULTS.maxPage).toBe(50);
  });

  it('uses a maximum page below ten as the default page, and refuses an explicit default page there', () => {
    expect(firstSource(load(baseSource({ budgets: { max_page: 1 } }))).budgets).toMatchObject({ maxPage: 1, defaultPage: 1 });
    expectRefused(baseSource({ budgets: { max_page: 1, default_page: 1 } }), 'sources[0].budgets.default_page', 'must be at least 10');
  });

  it('keeps the default page within a smaller maximum page', () => {
    expect(firstSource(load(baseSource({ budgets: { max_page: 20 } }))).budgets).toMatchObject({ maxPage: 20, defaultPage: 20 });
  });
});
