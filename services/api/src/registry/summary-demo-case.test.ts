import { describe, expect, it } from 'vitest';
import { deriveReferenceKeys } from '../reference/keys.js';
import { readToken } from '../reference/token.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { summariesOf } from './summary.js';

const keys = deriveReferenceKeys(Buffer.alloc(32, 5));
const row = (id: string) => ({ id, alias: id, state: 'connected' as const, stateReason: null, synthetic: true, lastTestAt: null });
const sourceOf = (entity: Record<string, unknown>, stableId: string) =>
  sourceWith('alpha', { synthetic: true, entities: [entity], relationships: [], derived: [], demo_case: { entity: { type: 'thing', id: stableId }, case_ref: 'REF-1' } });

describe('the demo case of the source summary', () => {
  it('carries the stable ID as it is for a type that is not keyed', () => {
    const mapping = mappingOf(sourceOf({ type: 'thing', label: 'Thing', stable_id: 'thingId' }, 'T-1'));
    expect(summariesOf([row('alpha')], mapping, undefined, keys)[0]?.demoCase).toMatchObject({ entityType: 'thing', stableId: 'T-1' });
  });

  it('carries the token, never the value, for a keyed type, readable for that source and type only', () => {
    const mapping = mappingOf(sourceOf({ type: 'thing', label: 'Thing', stable_id: 'thingId', pii: ['thingId'] }, '+1-212-555-0100'));
    const demo = summariesOf([row('alpha')], mapping, undefined, keys)[0]?.demoCase;
    expect(demo?.stableId).toMatch(/^p1\./);
    expect(JSON.stringify(demo)).not.toContain('212-555');
    expect(readToken(keys, { sourceId: 'alpha', entityType: 'thing' }, demo?.stableId ?? '')).toBe('+1-212-555-0100');
  });

  it('cannot be built for a keyed type without the keys', () => {
    const mapping = mappingOf(sourceOf({ type: 'thing', label: 'Thing', stable_id: 'thingId', pii: ['thingId'] }, 'V'));
    expect(() => summariesOf([row('alpha')], mapping)).toThrow();
  });
});
