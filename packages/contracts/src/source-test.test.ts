import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from './source-test.js';

const pass = {
  schemaVersion: 1,
  sourceId: 'demo',
  checkedAt: '2026-11-02T10:00:00.000Z',
  outcome: 'pass',
  state: 'connected',
  stateReason: null,
  server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
  versionSupported: true,
  operations: [{ name: 'execute', status: 'supported' }],
  readOnlyCheck: 'not-verified',
  loginCanWrite: null,
  mappingSummary: { entityTypes: 2, relationshipTypes: 1, derivedRules: 0 },
};

const fail = { ...pass, outcome: 'fail', state: 'unavailable', stateReason: 'The source could not be reached.', server: null, versionSupported: null, operations: [] };

describe('sourceTestReportSchema', () => {
  it.each([['a pass', pass], ['a fail with nothing known about the server', fail]])('accepts %s', (_name, report) => {
    expect(sourceTestReportSchema.safeParse(report).success).toBe(true);
  });

  it('accepts a server that reports an empty version, which is a warn', () => {
    expect(sourceTestReportSchema.safeParse({ ...pass, outcome: 'warn', state: 'degraded', stateReason: 'The server version is not on the support matrix.', versionSupported: false, operations: [], server: { product: 'Neo4j Kernel', version: '', edition: 'community' } }).success).toBe(true);
  });

  it.each([
    ['a login that cannot write, inspected', { ...pass, readOnlyCheck: 'privileges-inspected', loginCanWrite: false }],
    ['a login that can write, found by the privileges', { ...pass, outcome: 'warn', state: 'degraded', stateReason: 'The login can write to the source; give Neburyx a login that can only read.', readOnlyCheck: 'privileges-inspected', loginCanWrite: true }],
    ['a login that can write, found by the probe', { ...pass, readOnlyCheck: 'write-probe', loginCanWrite: true }],
  ])('accepts %s', (_name, report) => {
    expect(sourceTestReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...pass, address: 'bolt://x' }],
    ['another schema version', { ...pass, schemaVersion: 2 }],
    ['the state unknown', { ...pass, state: 'unknown' }],
    ['an outcome outside the list', { ...pass, outcome: 'maybe' }],
    ['a time that is not UTC ISO-8601', { ...pass, checkedAt: '2026-11-02 10:00' }],
    ['an empty reason', { ...pass, stateReason: '' }],
    ['an unknown read-only check', { ...pass, readOnlyCheck: 'guessed' }],
    ['no loginCanWrite', { ...pass, loginCanWrite: undefined }],
    ['a loginCanWrite that is not a boolean', { ...pass, loginCanWrite: 'yes' }],
    ['a loginCanWrite that is false while the read-only check is not verified', { ...pass, loginCanWrite: false }],
    ['a loginCanWrite that is null while the privileges were inspected', { ...pass, readOnlyCheck: 'privileges-inspected', loginCanWrite: null }],
    ['a loginCanWrite that is null after the write probe', { ...pass, readOnlyCheck: 'write-probe', loginCanWrite: null }],
    ['an operation status outside the list', { ...pass, operations: [{ name: 'execute', status: 'maybe' }] }],
    ['a negative count', { ...pass, mappingSummary: { entityTypes: -1, relationshipTypes: 1, derivedRules: 0 } }],
    ['a server with an unknown key', { ...pass, server: { product: 'x', version: '1', edition: 'y', host: 'z' } }],
  ])('refuses %s', (_name, report) => {
    expect(sourceTestReportSchema.safeParse(report).success).toBe(false);
  });
});
