import { describe, expect, it } from 'vitest';
import { CONNECT_TIMEOUT_KEY, MAX_CONNECT_TIMEOUT_MS, MIN_CONNECT_TIMEOUT_MS } from '../db/connect-timeout.js';
import { CONNECTION_TIMEOUT_MS } from '../db/pool.js';
import { MAX_READINESS_LIMIT_MS, MIN_READINESS_LIMIT_MS, READINESS_LIMIT_KEY, READINESS_LIMIT_MS } from '../health/readiness.js';
import { Doc } from '../testing/doc.js';

const flatOf = (path: string): string => new Doc(path).text.replace(/\s+/g, ' ');
const flat = flatOf('services/api/README.md');

describe('the probes in the API README', () => {
  it('name the readiness limit with its default and range', () => {
    expect(flat).toContain(`\`${READINESS_LIMIT_KEY}\` milliseconds (default ${READINESS_LIMIT_MS}, from ${MIN_READINESS_LIMIT_MS} to ${MAX_READINESS_LIMIT_MS})`);
  });

  it('name the connect limit with its default and range', () => {
    expect(flat).toContain(`\`${CONNECT_TIMEOUT_KEY}\` (default ${CONNECTION_TIMEOUT_MS}, from ${MIN_CONNECT_TIMEOUT_MS} to ${MAX_CONNECT_TIMEOUT_MS})`);
  });
});

describe('docs/run-locally.md', () => {
  const text = flatOf('docs/run-locally.md');

  it('names both limits with the defaults and ranges of the code', () => {
    expect(text).toContain(`\`${READINESS_LIMIT_KEY}\``);
    expect(text).toContain(`(default ${READINESS_LIMIT_MS}, from ${MIN_READINESS_LIMIT_MS} to ${MAX_READINESS_LIMIT_MS})`);
    expect(text).toContain(`\`${CONNECT_TIMEOUT_KEY}\``);
    expect(text).toContain(`(default ${CONNECTION_TIMEOUT_MS}, from ${MIN_CONNECT_TIMEOUT_MS} to ${MAX_CONNECT_TIMEOUT_MS})`);
  });

  it('still tells the reader to give the Neo4j source a uri that is an address', () => {
    expect(text).toMatch(/`uri`[^.]*address/);
  });
});

describe('docs/install.md', () => {
  const text = flatOf('docs/install.md');

  it('states the two limits in seconds, as the code has them, and points to the API README for the settings', () => {
    expect(text).toContain(`allows ${READINESS_LIMIT_MS / 1000} seconds`);
    expect(text).toContain(`within ${CONNECTION_TIMEOUT_MS / 1000} seconds`);
    expect(text).toContain('(../services/api/README.md)');
  });

  it('still tells the reader to give a source uri an address', () => {
    expect(text).toMatch(/`uri` is a different path: give it an address/);
  });
});
