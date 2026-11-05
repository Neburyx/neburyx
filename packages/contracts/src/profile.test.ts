import { describe, expect, it } from 'vitest';
import { sourceProfileSchema } from './profile.js';

const profile = {
  sourceId: 'demo',
  synthetic: false,
  vocabulary: { caseRef: null },
  entityTypes: [
    { type: 'node_a', label: 'NodeA', displayName: 'Node A', icon: 'generic', title: '{id}', titleUsesPii: false, keyProperties: ['id'], stateProperty: null, searchable: [], filterable: [], pii: [] },
  ],
  relationshipTypes: [{ type: 'LINKS', from: 'node_a', to: 'node_a', aggregate: true, observedAt: null, filterable: [], evidence: [] }],
  derivedRules: [{ id: 'r', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_a', 'LINKS'], ruleVersion: 1 }],
  presets: [{ id: 'p', name: 'P', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_a', via: 'LINKS' }, labels: [{ key: 'anchor', text: 'Start' }] }],
  mappingExcerpt: 'entities: []\n',
};

describe('source profile contract', () => {
  it('accepts a full profile', () => {
    expect(sourceProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('refuses a profile whose entity type has no display name or an empty one', () => {
    const { displayName: _removed, ...bare } = profile.entityTypes[0] ?? {};
    expect(sourceProfileSchema.safeParse({ ...profile, entityTypes: [bare] }).success).toBe(false);
    expect(sourceProfileSchema.safeParse({ ...profile, entityTypes: [{ ...bare, displayName: '' }] }).success).toBe(false);
  });

  it('refuses an unknown field at the top and inside an item, such as an address', () => {
    expect(sourceProfileSchema.safeParse({ ...profile, uri: 'neo4j://host' }).success).toBe(false);
    expect(sourceProfileSchema.safeParse({ ...profile, entityTypes: [{ ...profile.entityTypes[0], link: 'https://x.example.test/{id}' }] }).success).toBe(false);
    expect(sourceProfileSchema.safeParse({ ...profile, vocabulary: { caseRef: 'Ref', extra: 1 } }).success).toBe(false);
  });

  it('refuses an icon outside the fixed set and a bind key outside the known ones', () => {
    expect(sourceProfileSchema.safeParse({ ...profile, entityTypes: [{ ...profile.entityTypes[0], icon: 'sparkle' }] }).success).toBe(false);
    expect(sourceProfileSchema.safeParse({ ...profile, presets: [{ ...profile.presets[0], bind: { other: 'x' } }] }).success).toBe(false);
  });

  it('refuses a missing excerpt and a template that is not built in', () => {
    const { mappingExcerpt: _removed, ...without } = profile;
    expect(sourceProfileSchema.safeParse(without).success).toBe(false);
    expect(sourceProfileSchema.safeParse({ ...profile, presets: [{ ...profile.presets[0], template: 'free-form' }] }).success).toBe(false);
  });
});
