import type { EdgeRef, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { arrowOf } from './copy.js';

const end = (stableId: string) => ({ sourceId: 'a', entityType: 'type-a', stableId });
const stored: EdgeRef = { sourceId: 'a', type: 'rel', from: 'type-a', to: 'type-a', stableId: 'e1' };
const aggregate: EdgeRef = { sourceId: 'a', aggregate: { type: 'rel', from: end('n1'), to: end('n2') } };
const derived: EdgeRef = { sourceId: 'a', derived: { ruleId: 'rule-1', from: end('n1'), to: end('n2') } };

const withRule = (rule: { readonly from: string; readonly to: string; readonly via: string[] }): SourceProfile => ({
  ...testProfile('a', ['type-a']),
  derivedRules: [{ id: 'rule-1', ruleVersion: 1, ...rule }],
});

describe('the arrow between the ends of a relationship', () => {
  it('is one way for a stored relationship and for an aggregate one, whatever the profile holds', () => {
    const profile = withRule({ from: 'type-a', to: 'type-a', via: ['type-b'] });
    expect([arrowOf(stored, profile), arrowOf(aggregate, profile), arrowOf(stored, undefined)]).toEqual(['→', '→', '→']);
  });

  it('is both ways for a derived relationship whose rule has the same type at both ends and a chain that is its own reverse', () => {
    expect(arrowOf(derived, withRule({ from: 'type-a', to: 'type-a', via: ['type-b'] }))).toBe('↔');
    expect(arrowOf(derived, withRule({ from: 'type-a', to: 'type-a', via: ['type-b', 'type-c', 'type-b'] }))).toBe('↔');
  });

  it('is one way for a derived relationship whose rule does not read the same from either end, or whose rule the profile does not hold', () => {
    expect(arrowOf(derived, withRule({ from: 'type-a', to: 'type-b', via: ['type-c'] }))).toBe('→');
    expect(arrowOf(derived, withRule({ from: 'type-a', to: 'type-a', via: ['type-b', 'type-c'] }))).toBe('→');
    expect(arrowOf(derived, { ...withRule({ from: 'type-a', to: 'type-a', via: ['type-b'] }), derivedRules: [] })).toBe('→');
    expect(arrowOf(derived, undefined)).toBe('→');
  });
});
