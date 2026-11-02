import type { MappingChecks } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../testing/mapping.js';
import { reportFromServer } from './report.js';

const source = firstSource(load(baseSource()));
const server = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const at = '2026-11-02T10:00:00.000Z';
const warning = { severity: 'warn', check: 'sort-index', message: 'a plain warning' } as const;
const unverified = { severity: 'warn', check: 'stable-id-unverified', message: 'a duplicate check that ran out of time' } as const;
const failure = { severity: 'fail', check: 'label', message: 'no node carries the label' } as const;
const reportWith = (mapping: MappingChecks, found: Parameters<typeof reportFromServer>[4] = {}, canWrite: boolean | null = false) => reportFromServer(source, server, canWrite, at, { mapping, ...found });

describe('the reason of a report', () => {
  it('quotes the first finding that says something was not verified when the status is not-verified, though a plain warning comes first', () => {
    const report = reportWith({ status: 'not-verified', findings: [warning, unverified] });
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', stateReason: 'The mapping could not be fully checked: a duplicate check that ran out of time' });
  });

  it('quotes the first finding when the status is warn', () => {
    expect(reportWith({ status: 'warn', findings: [warning] }).stateReason).toBe('The mapping has warnings: a plain warning');
  });

  it('quotes the first failure, counts the others and says what to do when the status is fail, whatever else is found', () => {
    const report = reportWith({ status: 'fail', findings: [warning, failure, { ...failure, message: 'a second failure' }] }, {}, true);
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(report.stateReason).toBe('The mapping does not fit the source: no node carries the label (and 1 more). Fix the source, then run test-source or test it from the Sources page.');
  });

  it('gives the other warnings precedence over a mapping that was not verified, in the order the division sets', () => {
    expect(reportWith({ status: 'not-verified', findings: [unverified] }, {}, true).stateReason).toBe('The login can write to the source; give Neburyx a login that can only read.');
    expect(reportWith({ status: 'not-verified', findings: [unverified] }, { unreadable: true }).stateReason).toBe('The server listed privileges that could not be read, so read-only is not verified.');
  });

  it('has no reason for a mapping that passes or was not run on a supported server', () => {
    expect(reportWith({ status: 'pass', findings: [] }).stateReason).toBeNull();
    expect(reportWith({ status: 'not-run', findings: [] }).stateReason).toBeNull();
  });
});
