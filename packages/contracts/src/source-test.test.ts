import { describe, expect, it } from 'vitest';
import { DEGREE_BASIS_RESULT, sourceTestReportSchema } from './source-test.js';

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
  mappingChecks: { status: 'pass', findings: [] },
  degreeChecks: { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [{ entityType: 'gadget', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY'] }], warnings: [] },
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

const finding = (check: string, severity: string, extra: Record<string, unknown> = {}) => ({ severity, check, entityType: 'gadget', message: 'a fixed sentence', ...extra });
const withMapping = (mappingChecks: unknown, extra: Record<string, unknown> = {}) => ({ ...pass, ...extra, mappingChecks });
const failing = { outcome: 'fail', state: 'unavailable', stateReason: 'The mapping does not fit the source: a fixed sentence. Fix the source, then run test-source or test it from the Sources page.' };

describe('mappingChecks in the report', () => {
  it.each([
    ['pass without a finding', withMapping({ status: 'pass', findings: [] })],
    ['not-run without a finding', withMapping({ status: 'not-run', findings: [] })],
    ['warn with only warnings', withMapping({ status: 'warn', findings: [finding('sort-index', 'warn', { property: 'madeAt' })] }, { outcome: 'warn', state: 'degraded', stateReason: 'x' })],
    ['not-verified with a finding that something was not verified and a warning', withMapping({ status: 'not-verified', findings: [finding('sort-index', 'warn'), finding('schema-refused', 'warn')] }, { outcome: 'warn', state: 'degraded', stateReason: 'x' })],
    ['fail with a failure and a finding that something was not verified', withMapping({ status: 'fail', findings: [finding('label', 'fail'), finding('schema-refused', 'warn')] }, failing)],
    ['a relationship finding with its from and to', withMapping({ status: 'fail', findings: [finding('relationship-type', 'fail', { entityType: undefined, relationshipType: 'KNOWS', from: 'a', to: 'b' })] }, failing)],
  ])('accepts %s', (_name, report) => {
    expect(sourceTestReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    ['no mappingChecks', { ...pass, mappingChecks: undefined }],
    ['pass with a finding', withMapping({ status: 'pass', findings: [finding('sort-index', 'warn')] })],
    ['not-run with a finding', withMapping({ status: 'not-run', findings: [finding('sort-index', 'warn')] })],
    ['warn with no finding', withMapping({ status: 'warn', findings: [] })],
    ['warn with a failure', withMapping({ status: 'warn', findings: [finding('label', 'fail')] })],
    ['warn with a finding that something was not verified', withMapping({ status: 'warn', findings: [finding('schema-refused', 'warn')] })],
    ['not-verified with a failure', withMapping({ status: 'not-verified', findings: [finding('label', 'fail'), finding('schema-refused', 'warn')] })],
    ['not-verified with only a plain warning', withMapping({ status: 'not-verified', findings: [finding('sort-index', 'warn')] })],
    ['fail with no failure', withMapping({ status: 'fail', findings: [finding('sort-index', 'warn')] }, failing)],
    ['fail while the outcome is pass', withMapping({ status: 'fail', findings: [finding('label', 'fail')] })],
    ['fail while the state is degraded', withMapping({ status: 'fail', findings: [finding('label', 'fail')] }, { outcome: 'fail', state: 'degraded', stateReason: 'x' })],
    ['a check that is not known', withMapping({ status: 'fail', findings: [finding('guessed', 'fail')] }, failing)],
    ['a severity that does not match the check', withMapping({ status: 'fail', findings: [finding('label', 'warn')] }, failing)],
    ['a finding with an unknown key', withMapping({ status: 'fail', findings: [finding('label', 'fail', { value: 'x' })] }, failing)],
    ['an empty message', withMapping({ status: 'fail', findings: [finding('label', 'fail', { message: '' })] }, failing)],
    ['a status that is not known', withMapping({ status: 'maybe', findings: [] })],
  ])('refuses %s', (_name, report) => {
    expect(sourceTestReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('degreeChecks in the report', () => {
  const cheap = (entityType: string) => ({ entityType, result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY'] });
  const expand = { entityType: 'person', result: 'not-cheap', basis: 'expand', relationshipTypes: ['MADE_BY'] };
  const unclear = { entityType: 'person', result: 'could-not-tell', basis: 'timeout', relationshipTypes: ['MADE_BY'] };
  const NOT_RUN = { status: 'not-run', foundOn: null, types: [], warnings: [] };
  const withDegrees = (degreeChecks: unknown) => ({ ...pass, degreeChecks });
  const accepts = (degreeChecks: unknown) => sourceTestReportSchema.safeParse(withDegrees(degreeChecks)).success;

  it.each([
    ['not-run with nothing', NOT_RUN],
    ['pass with cheap types and no warning', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [cheap('gadget'), cheap('person')], warnings: [] }],
    ['warn with an expanding type and its one warning', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [cheap('gadget'), expand], warnings: ['w'] }],
    ['warn with a type that could not be told and its one warning', { status: 'warn', foundOn: 'Neo4j 2026.10.1', types: [unclear], warnings: ['w'] }],
  ])('accepts %s', (_name, degreeChecks) => {
    expect(accepts(degreeChecks)).toBe(true);
  });

  it.each([
    ['no degreeChecks', undefined],
    ['an unknown status', { ...NOT_RUN, status: 'fail' }],
    ['not-run with a found-on version', { ...NOT_RUN, foundOn: 'Neo4j 5.26.32' }],
    ['pass without a found-on version', { status: 'pass', foundOn: null, types: [cheap('gadget')], warnings: [] }],
    ['not-run with a type', { ...NOT_RUN, types: [cheap('gadget')] }],
    ['not-run with a warning', { ...NOT_RUN, warnings: ['w'] }],
    ['pass with no type', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [], warnings: [] }],
    ['pass with a type that is not cheap', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [expand], warnings: [] }],
    ['pass with a warning', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [cheap('gadget')], warnings: ['w'] }],
    ['warn with every type cheap', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [cheap('gadget')], warnings: [] }],
    ['warn with fewer warnings than types that are not cheap', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [expand, { ...unclear, entityType: 'gadget' }], warnings: ['w'] }],
    ['warn with more warnings than types that are not cheap', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [cheap('gadget'), expand], warnings: ['w', 'x'] }],
    ['a result that its basis cannot give', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [{ ...expand, result: 'cheap' }], warnings: ['w'] }],
    ['a result that its basis cannot give (cheap with a timeout)', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [{ ...cheap('gadget'), basis: 'timeout' }], warnings: [] }],
    ['a basis outside the eight', { status: 'warn', foundOn: 'Neo4j 5.26.32', types: [{ ...unclear, basis: 'guessed' }], warnings: ['w'] }],
    ['a type with no relationship type', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [{ ...cheap('gadget'), relationshipTypes: [] }], warnings: [] }],
    ['an unknown key in a type', { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [{ ...cheap('gadget'), dbHits: 3 }], warnings: [] }],
    ['an unknown key', { ...NOT_RUN, plan: [] }],
  ])('refuses %s', (_name, degreeChecks) => {
    expect(accepts(degreeChecks)).toBe(false);
  });

  it('knows the eight bases and the one result each gives', () => {
    expect(DEGREE_BASIS_RESULT).toEqual({
      'degree-operator': 'cheap',
      expand: 'not-cheap',
      'unrecognized-plan': 'could-not-tell',
      'no-plan': 'could-not-tell',
      unreadable: 'could-not-tell',
      timeout: 'could-not-tell',
      refused: 'could-not-tell',
      skipped: 'could-not-tell',
    });
  });
});
