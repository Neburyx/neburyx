import { describe, expect, it } from 'vitest';
import { ALL_UNCHECKED, createUsabilityRecord, type VerdictCheck } from './usability.js';

const reached = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };
const check = (overrides: Partial<VerdictCheck> = {}): VerdictCheck => ({ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:10.000Z', server: reached, mappingChecks: { status: 'pass', findings: [] }, ...overrides });
const failed: VerdictCheck['mappingChecks'] = { status: 'fail', findings: [{ severity: 'fail', check: 'label', message: 'x' }] };

describe('the record of what is usable', () => {
  it('holds every source unchecked and unusable until a check that reached it', () => {
    const record = createUsabilityRecord();
    expect([record.verdictOf('alpha'), record.isUsable('alpha')]).toEqual(['unchecked', false]);
    record.observe(check({ server: null }));
    expect(record.verdictOf('alpha')).toBe('unchecked');
  });

  it.each([
    ['pass', { status: 'pass', findings: [] }],
    ['warn', { status: 'warn', findings: [{ severity: 'warn', check: 'sort-index', message: 'x' }] }],
    ['not-verified', { status: 'not-verified', findings: [{ severity: 'warn', check: 'schema-refused', message: 'x' }] }],
    ['not-run', { status: 'not-run', findings: [] }],
  ] satisfies [string, VerdictCheck['mappingChecks']][])('makes a source usable after a %s', (_name, mappingChecks) => {
    const record = createUsabilityRecord();
    record.observe(check({ mappingChecks }));
    expect([record.verdictOf('alpha'), record.isUsable('alpha')]).toEqual(['usable', true]);
  });

  it('makes a source unusable after a failed mapping check, and usable again after a newer pass', () => {
    const record = createUsabilityRecord();
    record.observe(check({ mappingChecks: failed }));
    expect([record.verdictOf('alpha'), record.isUsable('alpha')]).toEqual(['unusable', false]);
    record.observe(check({ checkedAt: '2026-11-02T10:00:20.000Z' }));
    expect(record.verdictOf('alpha')).toBe('usable');
  });

  it('ignores a check older than the one it holds, whichever order they arrive in', () => {
    const record = createUsabilityRecord();
    record.observe(check({ checkedAt: '2026-11-02T10:00:20.000Z', mappingChecks: failed }));
    record.observe(check({ checkedAt: '2026-11-02T10:00:10.000Z' }));
    expect(record.verdictOf('alpha')).toBe('unusable');
  });

  it('keeps its verdict when a check that did not reach the source arrives, however new', () => {
    const record = createUsabilityRecord();
    record.observe(check());
    record.observe(check({ checkedAt: '2026-11-02T11:00:00.000Z', server: null, mappingChecks: { status: 'not-run', findings: [] } }));
    expect(record.verdictOf('alpha')).toBe('usable');
  });

  it('keeps a verdict per source', () => {
    const record = createUsabilityRecord();
    record.observe(check());
    record.observe(check({ sourceId: 'beta', mappingChecks: failed }));
    expect([record.verdictOf('alpha'), record.verdictOf('beta'), record.verdictOf('gamma')]).toEqual(['usable', 'unusable', 'unchecked']);
  });

  it('holds a verdict for a check at the very time of the one it holds (the later one wins)', () => {
    const record = createUsabilityRecord();
    record.observe(check({ mappingChecks: failed }));
    record.observe(check());
    expect(record.verdictOf('alpha')).toBe('usable');
  });

  it('has a stand-in in which nothing is usable', () => {
    expect(ALL_UNCHECKED.isUsable('alpha')).toBe(false);
  });
});
