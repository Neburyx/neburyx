import { describe, expect, it } from 'vitest';
import { entityOf, graphOf, keyOf, profileWith } from './group-kit.js';
import { guardedGroups, type GuardInput } from './group-guard.js';
import { propertyBy, type Group } from './group-model.js';

const a1 = entityOf('kind-a', 'A1', { currency: 'USD', tier: 'x' });
const a2 = entityOf('kind-a', 'A2', { currency: 'USD', tier: 'x' });
const d1 = entityOf('kind-d', 'DV1', { tier: 'y' });
const profile = profileWith({ 'kind-a': { pii: ['tier'], properties: ['currency', 'tier'] }, 'kind-d': { properties: ['tier'] } });
const currency: Group = { id: 'property:currency:1', by: propertyBy('currency'), members: [keyOf(a1), keyOf(a2)], collapsed: true };
const tier: Group = { id: 'property:tier:1', by: propertyBy('tier'), members: [keyOf(a1), keyOf(a2)], collapsed: true };
const byType: Group = { id: 'type:kind-a', by: 'entityType', members: [keyOf(a1), keyOf(a2)], collapsed: true };
const input = (over: Partial<GuardInput> = {}): GuardInput => ({ groups: [currency, tier, byType], graph: graphOf([a1, a2, d1]), profile, profileFailed: false, masking: false, rereading: false, ...over });

describe('the groupings that may stand', () => {
  it('keeps every grouping when nothing is wrong, and returns the same list', () => {
    const held = input();
    expect(guardedGroups(held).groups).toBe(held.groups);
    expect(guardedGroups(held).note).toBeUndefined();
  });

  it('removes a grouping by a property that a type of its members marks pii once masking is on, and keeps the others, before the view is read again', () => {
    const outcome = guardedGroups(input({ masking: true, rereading: true, graph: graphOf([]) }));
    expect(outcome.groups).toEqual([currency, byType]);
    expect(outcome.note).toBe('masked');
  });

  it('removes a grouping by a property that a policy masks on any loaded entity, whatever the flag says', () => {
    const policy = { ...d1, properties: [{ key: 'currency', value: 'x', dataClass: 'text' as const, masked: true, maskedBy: 'policy' as const }] };
    const outcome = guardedGroups(input({ graph: graphOf([a1, a2, policy]) }));
    expect(outcome.groups.map((group) => group.id)).toEqual(['property:tier:1', 'type:kind-a']);
    expect(outcome.note).toBe('masked');
  });

  it('removes a grouping by a property the mapping no longer names for its members, or whose members no longer share one value', () => {
    const moved = entityOf('kind-a', 'A2', { currency: 'EUR', tier: 'x' });
    expect(guardedGroups(input({ graph: graphOf([a1, moved, d1]) })).groups.map((group) => group.id)).toEqual(['property:tier:1', 'type:kind-a']);
    const unmapped = profileWith({ 'kind-a': { properties: ['tier'] } });
    const outcome = guardedGroups(input({ profile: unmapped }));
    expect(outcome.groups.map((group) => group.id)).toEqual(['property:tier:1', 'type:kind-a']);
    expect(outcome.note).toBe('values');
  });

  it('waits while the profile is read, and removes a grouping by a property when it could not be read', () => {
    expect(guardedGroups(input({ profile: undefined })).groups).toHaveLength(3);
    const failed = guardedGroups(input({ profile: undefined, profileFailed: true }));
    expect(failed.groups).toEqual([byType]);
    expect(failed.note).toBe('profile');
  });

  it('leaves a grouping by entity type and by component whatever the profile says', () => {
    const component: Group = { id: 'component:1', by: 'component', members: [keyOf(a1)], collapsed: true };
    expect(guardedGroups(input({ groups: [byType, component], profile: undefined, profileFailed: true, masking: true })).groups).toEqual([byType, component]);
  });
});
