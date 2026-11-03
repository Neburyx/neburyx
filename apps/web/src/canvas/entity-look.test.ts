import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { node } from '../state/test-data.js';
import { entityLook } from './entity-look.js';

function profileWith(overrides: Partial<SourceProfile['entityTypes'][number]>): SourceProfile {
  const base = testProfile('source-a');
  const first = base.entityTypes[0];
  if (first === undefined) throw new Error('the test profile has no entity type');
  return { ...base, entityTypes: [{ ...first, type: 'type-a', label: 'Alpha', icon: 'money', stateProperty: 'status', ...overrides }, ...base.entityTypes.slice(1)] };
}

function entity(properties: GraphNode['properties'], title = 'ACC-48291'): GraphNode {
  return { ...node('source-a', 'n1'), display: { title, type: 'type-a' }, properties };
}

const status = (value: unknown) => ({ key: 'status', value, dataClass: 'text' as const, masked: false });

describe('the look of an entity', () => {
  it('shows the title on line 1 and "Type · state" on line 2, with the type name and the icon from the profile', () => {
    expect(entityLook(entity([status('Review required')]), profileWith({}))).toEqual({ iconKey: 'money', line1: 'ACC-48291', line2: 'Alpha · Review required' });
  });

  it('shows the type name alone when the type has no state property', () => {
    expect(entityLook(entity([status('Open')]), profileWith({ stateProperty: null })).line2).toBe('Alpha');
  });

  it('shows the type name alone when the entity has no value for the state property, or one that is masked or not a plain value', () => {
    expect(entityLook(entity([]), profileWith({})).line2).toBe('Alpha');
    expect(entityLook(entity([{ key: 'status', dataClass: 'text', masked: true, maskedBy: 'policy' }]), profileWith({})).line2).toBe('Alpha');
    expect(entityLook(entity([status({ nested: true })]), profileWith({})).line2).toBe('Alpha');
    expect(entityLook(entity([status(null)]), profileWith({})).line2).toBe('Alpha');
  });

  it('writes a number or a boolean state as text', () => {
    expect(entityLook(entity([status(3)]), profileWith({})).line2).toBe('Alpha · 3');
    expect(entityLook(entity([status(false)]), profileWith({})).line2).toBe('Alpha · false');
  });

  it('shows the generic icon and the raw type name until the profile is known', () => {
    expect(entityLook(entity([status('Open')]), undefined)).toEqual({ iconKey: 'generic', line1: 'ACC-48291', line2: 'type-a' });
  });

  it('shows the generic icon and the raw type name for a type the profile does not list, and no error', () => {
    const other = { ...node('source-a', 'n2'), ref: { sourceId: 'source-a', entityType: 'unlisted', stableId: 'n2' } };
    expect(entityLook(other, profileWith({}))).toMatchObject({ iconKey: 'generic', line2: 'unlisted' });
  });
});
