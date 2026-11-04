import type { LastTest, SourceSummary } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { degreeNotice, formatUtc, healthFacts, lastTestView, mappingText } from './health-facts.js';

const summary = (overrides: Partial<SourceSummary> = {}): SourceSummary => ({
  id: 'a',
  alias: 'a',
  state: 'connected',
  stateReason: null,
  readOnly: true,
  synthetic: true,
  lastTestAt: null,
  lastTest: null,
  mappingSummary: { entityTypes: 8, relationshipTypes: 12, derivedRules: 1 },
  ...overrides,
});

const test = (overrides: Partial<LastTest> = {}): LastTest => ({
  checkedAt: '2026-10-30T10:16:08.000Z',
  outcome: 'pass',
  server: { product: 'Neo4j Kernel', version: '5.26.32' },
  versionSupported: true,
  readOnlyCheck: 'privileges-inspected',
  loginCanWrite: false,
  degreeStatus: 'pass',
  degreeWarnings: [],
  ...overrides,
});

const facts = (source: SourceSummary, held?: LastTest) => Object.fromEntries(healthFacts(source, lastTestView(source, held)).map((fact) => [fact.label, fact.value]));

const zone = process.env['TZ'];
afterEach(() => {
  if (zone === undefined) delete process.env['TZ'];
  else process.env['TZ'] = zone;
});

describe('the last test shown for a source', () => {
  it('is never tested when the source has no test at all', () => {
    expect(lastTestView(summary())).toEqual({ kind: 'never' });
    expect(facts(summary())).toEqual({ 'Last test': 'Never tested', Connection: 'Not tested yet', 'Read-only verified': 'Not tested yet', 'Mapping valid': '8 entity types · 12 relationship types · 1 derived rule' });
  });

  it('is not tested with the current configuration when only a test of another one exists, and shows its time', () => {
    const source = summary({ lastTestAt: '2026-10-30T10:16:08.000Z' });
    expect(lastTestView(source)).toEqual({ kind: 'other-configuration', checkedAt: '2026-10-30T10:16:08.000Z' });
    expect(facts(source)).toMatchObject({ 'Last test': '30 Oct 2026, 10:16:08 UTC', Connection: 'Not tested with the current configuration', 'Read-only verified': 'Not tested with the current configuration' });
  });

  it('shows the time of the stored test even when lastTestAt is newer, since the facts belong to that test', () => {
    const source = summary({ lastTestAt: '2026-10-31T09:00:00.000Z', lastTest: test() });
    expect(facts(source)['Last test']).toBe('30 Oct 2026, 10:16:08 UTC');
  });

  it('shows the server product and version as given, and nothing trimmed', () => {
    expect(facts(summary({ lastTestAt: test().checkedAt, lastTest: test() }))['Connection']).toBe('Neo4j Kernel 5.26.32');
    expect(facts(summary({ lastTestAt: test().checkedAt, lastTest: test({ server: { product: 'Neo4j Kernel', version: '' } }) }))['Connection']).toBe('Neo4j Kernel');
  });

  it('says the version is unsupported only when the server said so', () => {
    expect(facts(summary({ lastTest: test({ versionSupported: false }) }))['Connection']).toBe('Neo4j Kernel 5.26.32 · unsupported version');
    expect(facts(summary({ lastTest: test({ versionSupported: null }) }))['Connection']).toBe('Neo4j Kernel 5.26.32');
  });

  it('says not reached only when no server answered, and keeps the connection of a failed test that had one', () => {
    expect(facts(summary({ lastTest: test({ outcome: 'fail', server: null, versionSupported: null }) }))['Connection']).toBe('Not reached');
    expect(facts(summary({ lastTest: test({ outcome: 'fail' }) }))['Connection']).toBe('Neo4j Kernel 5.26.32');
  });

  it.each([
    ['privileges-inspected', false, 'Privileges inspected'],
    ['privileges-inspected', true, 'Privileges inspected · the login can write'],
    ['write-probe', false, 'Write probe, rolled back'],
    ['not-verified', null, 'Not verified'],
  ] as const)('reads the read-only check %s with a login that can write: %s as "%s"', (readOnlyCheck, loginCanWrite, text) => {
    expect(facts(summary({ lastTest: test({ readOnlyCheck, loginCanWrite }) }))['Read-only verified']).toBe(text);
  });

  it('uses the singular for one and the plural for zero and many, with the counts as given', () => {
    expect(mappingText({ entityTypes: 1, relationshipTypes: 1, derivedRules: 1 })).toBe('1 entity type · 1 relationship type · 1 derived rule');
    expect(mappingText({ entityTypes: 0, relationshipTypes: 2, derivedRules: 0 })).toBe('0 entity types · 2 relationship types · 0 derived rules');
  });
});

describe('a report held from a test run in this visit', () => {
  const stored = test({ checkedAt: '2026-10-30T10:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.1' } });
  const held = test({ checkedAt: '2026-10-30T11:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.2' } });

  it('is shown when it is newer than the stored test or when there is none', () => {
    expect(lastTestView(summary({ lastTest: stored }), held)).toEqual({ kind: 'tested', test: held });
    expect(lastTestView(summary(), held)).toEqual({ kind: 'tested', test: held });
    expect(lastTestView(summary({ lastTestAt: '2026-10-29T00:00:00.000Z' }), held)).toEqual({ kind: 'tested', test: held });
  });

  it('gives way to a stored test that is newer', () => {
    expect(lastTestView(summary({ lastTest: held }), stored)).toEqual({ kind: 'tested', test: held });
  });

  it('gives way to the stored test when both have the same time, whatever else they say', () => {
    const other = test({ ...held, outcome: 'warn' });
    expect(lastTestView(summary({ lastTest: held }), other)).toEqual({ kind: 'tested', test: held });
  });

  it('compares the instants, not the text, so times written with different precision are ordered right', () => {
    const storedWhole = test({ checkedAt: '2026-10-30T10:00:00Z' });
    const heldLater = test({ checkedAt: '2026-10-30T10:00:00.100Z' });
    expect(lastTestView(summary({ lastTest: storedWhole }), heldLater)).toEqual({ kind: 'tested', test: heldLater });
    expect(lastTestView(summary({ lastTest: heldLater }), storedWhole)).toEqual({ kind: 'tested', test: heldLater });
  });
});

describe('the time of a test', () => {
  it('is written in UTC to the second whatever the time zone of the browser', () => {
    process.env['TZ'] = 'America/Los_Angeles';
    expect(formatUtc('2026-10-30T10:16:08.000Z')).toBe('30 Oct 2026, 10:16:08 UTC');
    process.env['TZ'] = 'Asia/Kolkata';
    expect(formatUtc('2026-01-05T23:59:59.000Z')).toBe('5 Jan 2026, 23:59:59 UTC');
  });
});

describe('the degree notice of a last test', () => {
  const noticeOf = (source: SourceSummary, held?: LastTest) => degreeNotice(lastTestView(source, held));

  it('carries the server sentences word for word, estimated and could-not-check alike', () => {
    const warnings = ['Degree counts are estimated for thing: no cheap per-type degree index', 'Degree counts could not be checked for other: the probe timed out'];
    expect(noticeOf(summary({ lastTest: test({ degreeStatus: 'warn', degreeWarnings: warnings }) }))).toEqual({ kind: 'warnings', warnings });
  });

  it('is nothing when the check passed, and for a source with no test', () => {
    expect(noticeOf(summary({ lastTest: test() }))).toBeUndefined();
    expect(noticeOf(summary())).toBeUndefined();
    expect(noticeOf(summary({ lastTestAt: '2026-10-30T10:16:08.000Z' }))).toBeUndefined();
  });

  it('says the check was not run for a test that did not run it', () => {
    expect(noticeOf(summary({ lastTest: test({ degreeStatus: 'not-run' }) }))).toEqual({ kind: 'not-run' });
  });

  it('follows the held report over the stored test', () => {
    const stored = test({ degreeStatus: 'warn', degreeWarnings: ['Degree counts are estimated for thing: no cheap per-type degree index'] });
    expect(noticeOf(summary({ lastTest: stored }), test({ checkedAt: '2026-10-31T10:00:00.000Z' }))).toBeUndefined();
  });
});
