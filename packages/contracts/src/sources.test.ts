import { describe, expect, it } from 'vitest';
import { lastTestSchema, SOURCE_STATES, sourcesResponseSchema, sourceSummarySchema } from './sources.js';

const item = {
  id: 'demo',
  alias: 'demo',
  state: 'unknown',
  stateReason: null,
  readOnly: true,
  synthetic: false,
  lastTestAt: null,
  lastTest: null,
  mappingSummary: { entityTypes: 3, relationshipTypes: 2, derivedRules: 1 },
};

describe('source list contract', () => {
  it('accepts a list with one source and a null next cursor', () => {
    expect(sourcesResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true);
  });

  it('accepts every source state and refuses one outside the list', () => {
    for (const state of SOURCE_STATES) expect(sourceSummarySchema.safeParse({ ...item, state }).success).toBe(true);
    expect(sourceSummarySchema.safeParse({ ...item, state: 'disabled' }).success).toBe(false);
  });

  it('refuses a read-only flag that is not true, a cursor that is not null and an unknown field', () => {
    expect(sourceSummarySchema.safeParse({ ...item, readOnly: false }).success).toBe(false);
    expect(sourcesResponseSchema.safeParse({ items: [], nextCursor: 'x' }).success).toBe(false);
    expect(sourceSummarySchema.safeParse({ ...item, uri: 'neo4j://host' }).success).toBe(false);
  });

  it('accepts a UTC ISO-8601 last test time and refuses anything else', () => {
    expect(sourceSummarySchema.safeParse({ ...item, lastTestAt: '2026-11-01T10:00:00Z' }).success).toBe(true);
    expect(sourceSummarySchema.safeParse({ ...item, lastTestAt: '2026-11-01T10:00:00.250Z' }).success).toBe(true);
    for (const bad of ['yesterday', '2026-11-01', '2026-11-01T10:00:00+02:00', '']) {
      expect(sourceSummarySchema.safeParse({ ...item, lastTestAt: bad }).success).toBe(false);
    }
  });

  it('refuses a negative or fractional definition count', () => {
    expect(sourceSummarySchema.safeParse({ ...item, mappingSummary: { ...item.mappingSummary, entityTypes: -1 } }).success).toBe(false);
    expect(sourceSummarySchema.safeParse({ ...item, mappingSummary: { ...item.mappingSummary, derivedRules: 1.5 } }).success).toBe(false);
  });

  describe('last test', () => {
    const lastTest = {
      checkedAt: '2026-11-01T10:00:00.000Z',
      outcome: 'pass',
      server: { product: 'Neo4j', version: '5.26.32' },
      versionSupported: true,
      readOnlyCheck: 'privileges-inspected',
      loginCanWrite: false,
      degreeStatus: 'warn',
      degreeWarnings: ['Degree counts are estimated for thing: no cheap per-type degree index'],
    };

    it('accepts a summary of a test that reached the server and one that did not', () => {
      expect(sourceSummarySchema.safeParse({ ...item, lastTest }).success).toBe(true);
      const unreached = { ...lastTest, outcome: 'fail', server: null, versionSupported: null, readOnlyCheck: 'not-verified', loginCanWrite: null, degreeStatus: 'not-run', degreeWarnings: [] };
      expect(lastTestSchema.safeParse(unreached).success).toBe(true);
    });

    it('refuses a version verdict when the server did not answer', () => {
      expect(lastTestSchema.safeParse({ ...lastTest, server: null }).success).toBe(false);
    });

    it('refuses an unknown field, a server edition and a value outside a list', () => {
      expect(lastTestSchema.safeParse({ ...lastTest, uri: 'neo4j://host' }).success).toBe(false);
      expect(lastTestSchema.safeParse({ ...lastTest, server: { ...lastTest.server, edition: 'community' } }).success).toBe(false);
      expect(lastTestSchema.safeParse({ ...lastTest, outcome: 'skipped' }).success).toBe(false);
      expect(lastTestSchema.safeParse({ ...lastTest, readOnlyCheck: 'trusted' }).success).toBe(false);
      expect(lastTestSchema.safeParse({ ...lastTest, degreeStatus: 'cheap' }).success).toBe(false);
      expect(lastTestSchema.safeParse({ ...lastTest, degreeWarnings: [''] }).success).toBe(false);
    });

    it('refuses a test time that is not a UTC ISO-8601 time', () => {
      expect(lastTestSchema.safeParse({ ...lastTest, checkedAt: 'yesterday' }).success).toBe(false);
    });
  });
});
