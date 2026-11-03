import { describe, expect, it } from 'vitest';
import { readStoredReport } from './stored-report.js';

/** A report as earlier versions stored it: before the verdict on the login was added it has no `loginCanWrite`, and before the mapping checks were added no `mappingChecks`. */
const stored = {
  schemaVersion: 1,
  sourceId: 'alpha',
  checkedAt: '2026-11-02T10:00:00.000Z',
  outcome: 'pass',
  state: 'connected',
  stateReason: null,
  server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
  versionSupported: true,
  operations: [{ name: 'execute', status: 'supported' }],
  readOnlyCheck: 'not-verified',
  mappingSummary: { entityTypes: 2, relationshipTypes: 1, derivedRules: 0 },
};

describe('reading a stored report', () => {
  it('reads a report from before the privileges were inspected as not verified, with no mapping checks run', () => {
    expect(readStoredReport(stored)).toMatchObject({ readOnlyCheck: 'not-verified', loginCanWrite: null, mappingChecks: { status: 'not-run', findings: [] } });
  });

  it('reads a report from before the mapping checks as not run, and keeps what it said about the login', () => {
    expect(readStoredReport({ ...stored, readOnlyCheck: 'privileges-inspected', loginCanWrite: false })).toMatchObject({ loginCanWrite: false, mappingChecks: { status: 'not-run' } });
  });

  it('reads a report from before the degree checks as not run', () => {
    expect(readStoredReport({ ...stored, loginCanWrite: null, mappingChecks: { status: 'pass', findings: [] } })).toMatchObject({ degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
  });

  it('reads a report of this version as it is', () => {
    const current = { ...stored, loginCanWrite: null, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] }, mappingChecks: { status: 'warn', findings: [{ severity: 'warn', check: 'sort-index', message: 'a warning' }] }, outcome: 'warn', state: 'degraded', stateReason: 'x' };
    expect(readStoredReport(current)).toEqual(current);
  });

  it.each([
    ['text', 'not a report'],
    ['nothing', null],
    ['a list', []],
    ['a report with an unknown key', { ...stored, address: 'bolt://x' }],
    ['a report that is inconsistent', { ...stored, readOnlyCheck: 'privileges-inspected' }],
  ])('refuses %s', (_name, value) => {
    expect(() => readStoredReport(value)).toThrow();
  });
});
