import { edgeSchema, nodeSchema, type SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { edgeKey, elementKey } from '../state/keys.js';
import { FIXTURE_ELEMENTS, FIXTURE_PINS, FixtureError, generateAddition, generateFixtureGraph } from './fixture-graph.js';
import { testProfile } from './test-profile.js';

describe('the fixture graph', () => {
  it('has 300 drawn elements and 10 pins, all of the profile\'s source', () => {
    const graph = generateFixtureGraph(testProfile(), 1);
    expect(graph.nodes.length + graph.edges.length).toBe(FIXTURE_ELEMENTS);
    expect(graph.pins).toHaveLength(FIXTURE_PINS);
    expect(new Set(graph.pins.map((pin) => pin.stableId)).size).toBe(FIXTURE_PINS);
    expect(graph.nodes.every((node) => node.ref.sourceId === 'source-a')).toBe(true);
    expect(graph.edges.every((edge) => edge.ref.sourceId === 'source-a')).toBe(true);
  });

  it('is the same for the same profile and seed and different for another seed', () => {
    expect(generateFixtureGraph(testProfile(), 7)).toEqual(generateFixtureGraph(testProfile(), 7));
    expect(generateFixtureGraph(testProfile(), 8)).not.toEqual(generateFixtureGraph(testProfile(), 7));
  });

  it('validates against the contract schemas, node by node and edge by edge', () => {
    const graph = generateFixtureGraph(testProfile(), 3);
    for (const node of graph.nodes) expect(nodeSchema.safeParse(node).success).toBe(true);
    for (const edge of graph.edges) expect(edgeSchema.safeParse(edge).success).toBe(true);
  });

  it('joins nodes of the entity types each relationship type names, and uses only the profile\'s type names', () => {
    const profile = testProfile();
    const graph = generateFixtureGraph(profile, 5);
    const rules = new Map(profile.relationshipTypes.map((relationship) => [relationship.type, relationship]));
    const derived = new Map(profile.derivedRules.map((rule) => [rule.id, rule]));
    for (const edge of graph.edges) {
      const rule = rules.get(edge.type) ?? derived.get(edge.type);
      expect(rule, edge.type).toBeDefined();
      expect([edge.from.entityType, edge.to.entityType]).toEqual([rule?.from, rule?.to]);
    }
    expect(new Set(graph.nodes.map((node) => node.ref.entityType))).toEqual(new Set(profile.entityTypes.map((entityType) => entityType.type)));
  });

  it('draws an aggregate relationship type as one aggregate edge per pair, with an aggregate ref and an exact member count, never as separate relationships', () => {
    const graph = generateFixtureGraph(testProfile(), 2);
    const aggregates = graph.edges.filter((edge) => edge.type === 'link-b');
    expect(aggregates.length).toBeGreaterThan(0);
    for (const edge of aggregates) {
      expect('aggregate' in edge.ref).toBe(true);
      expect(edge.memberCount).toMatchObject({ quality: 'exact' });
    }
    const pairs = aggregates.map((edge) => `${edge.from.stableId}|${edge.to.stableId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(graph.edges.filter((edge) => edge.type !== 'link-b' && edge.memberCount !== undefined)).toEqual([]);
  });

  it('draws derived edges for the profile\'s rules with a derivation and no stable id', () => {
    const graph = generateFixtureGraph(testProfile(), 2);
    const derived = graph.edges.filter((edge) => edge.semantics === 'derived');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((edge) => edge.derivation?.ruleId === 'rule-1' && 'derived' in edge.ref)).toBe(true);
  });

  it('refuses a profile with no entity types or no usable relationship types, with a named error', () => {
    const none: SourceProfile = { ...testProfile(), entityTypes: [] };
    expect(() => generateFixtureGraph(none, 1)).toThrowError(expect.objectContaining({ code: 'NO_ENTITY_TYPES' }));
    const noRelationships: SourceProfile = { ...testProfile(), relationshipTypes: [] };
    expect(() => generateFixtureGraph(noRelationships, 1)).toThrowError(FixtureError);
    expect(() => generateFixtureGraph(noRelationships, 1)).toThrowError(expect.objectContaining({ code: 'NO_RELATIONSHIP_TYPES' }));
    const dangling: SourceProfile = { ...testProfile(), relationshipTypes: [{ type: 'link-x', from: 'nope', to: 'kind-a', aggregate: false, observedAt: null, filterable: [], evidence: [] }] };
    expect(() => generateFixtureGraph(dangling, 1)).toThrowError(expect.objectContaining({ code: 'NO_RELATIONSHIP_TYPES' }));
  });

  it('works for a profile with one entity type only when its relationships join that type', () => {
    const profile: SourceProfile = { ...testProfile('s', ['only']), relationshipTypes: [{ type: 'self', from: 'only', to: 'only', aggregate: false, observedAt: null, filterable: [], evidence: [] }], derivedRules: [] };
    const graph = generateFixtureGraph(profile, 1);
    expect(graph.nodes.length + graph.edges.length).toBe(FIXTURE_ELEMENTS);
  });
});

describe('the size of the fixture graph', () => {
  const unique = (graph: ReturnType<typeof generateFixtureGraph>): number => new Set([...graph.nodes.map((node) => elementKey(node.ref)), ...graph.edges.map((edge) => edgeKey(edge.ref))]).size;

  it('is exactly 300 distinct elements for every one of 300 seeds', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const graph = generateFixtureGraph(testProfile(), seed);
      expect(graph.nodes.length + graph.edges.length, `seed ${seed}`).toBe(FIXTURE_ELEMENTS);
      expect(unique(graph), `seed ${seed}`).toBe(FIXTURE_ELEMENTS);
    }
  });

  it('stays 300 for a profile with 100 derived rules, whose own budget would otherwise overrun it', () => {
    const profile: SourceProfile = { ...testProfile(), derivedRules: Array.from({ length: 100 }, (_item, index) => ({ id: `rule-${index}`, from: 'kind-a', to: 'kind-b', via: ['link-a'], ruleVersion: 1 })) };
    const graph = generateFixtureGraph(profile, 4);
    expect(graph.nodes.length + graph.edges.length).toBe(FIXTURE_ELEMENTS);
    expect(graph.edges.filter((edge) => edge.semantics === 'derived').length).toBeLessThanOrEqual(22);
  });

  it('is 300 for a profile with 130 entity types, of which only 120 get a node, using the relationship types whose ends have nodes', () => {
    const types = Array.from({ length: 130 }, (_item, index) => `kind-${index}`);
    const graph = generateFixtureGraph(testProfile('source-a', types), 1);
    expect(graph.nodes.length + graph.edges.length).toBe(FIXTURE_ELEMENTS);
    expect(graph.nodes.some((node) => node.ref.entityType === 'kind-129')).toBe(false);
  });

  it('is 300 with one aggregate relationship type between two types of 60 nodes each, the pairs being enough', () => {
    const profile: SourceProfile = { ...testProfile('s', ['one', 'two']), relationshipTypes: [{ type: 'only-aggregate', from: 'one', to: 'two', aggregate: true, observedAt: null, filterable: [], evidence: [] }], derivedRules: [] };
    const graph = generateFixtureGraph(profile, 2);
    expect(graph.nodes.length + graph.edges.length).toBe(FIXTURE_ELEMENTS);
  });

  it('is refused by name when the distinct relationships the profile allows are too few, instead of coming out smaller than 300', () => {
    const types = Array.from({ length: 130 }, (_item, index) => `kind-${index}`);
    const profile: SourceProfile = { ...testProfile('s', types), relationshipTypes: [{ type: 'only-aggregate', from: 'kind-0', to: 'kind-1', aggregate: true, observedAt: null, filterable: [], evidence: [] }], derivedRules: [] };
    expect(() => generateFixtureGraph(profile, 1)).toThrowError(expect.objectContaining({ code: 'PROFILE_TOO_SMALL' }));
  });

  it('gives an entity of a type with a state property a synthetic state, and one of a type without none', () => {
    const profile = testProfile('source-a');
    const [first, ...rest] = profile.entityTypes;
    if (first === undefined) throw new Error('the test profile has no entity type');
    const graph = generateFixtureGraph({ ...profile, entityTypes: [{ ...first, stateProperty: 'status' }, ...rest] }, 1);
    const withState = graph.nodes.filter((node) => node.ref.entityType === first.type);
    expect(withState.length).toBeGreaterThan(0);
    expect(withState.every((node) => node.properties.length === 1 && node.properties[0]?.key === 'status')).toBe(true);
    expect(new Set(withState.map((node) => node.properties[0]?.value)).size).toBeGreaterThan(1);
    expect(graph.nodes.filter((node) => node.ref.entityType !== first.type).every((node) => node.properties.length === 0)).toBe(true);
  });
});

describe('an addition to the fixture graph', () => {
  const richProfile = (): SourceProfile => ({
    ...testProfile('source-a', ['kind-a', 'kind-b', 'kind-c', 'kind-d']),
    relationshipTypes: [
      { type: 'link-ab', from: 'kind-a', to: 'kind-b', aggregate: false, observedAt: null, filterable: [], evidence: [] },
      { type: 'link-bc', from: 'kind-b', to: 'kind-c', aggregate: false, observedAt: null, filterable: [], evidence: [] },
      { type: 'link-cc', from: 'kind-c', to: 'kind-c', aggregate: false, observedAt: null, filterable: [], evidence: [] },
      { type: 'link-ad', from: 'kind-a', to: 'kind-d', aggregate: true, observedAt: null, filterable: [], evidence: [] },
    ],
  });
  const endpointsFit = (profile: SourceProfile, addition: ReturnType<typeof generateAddition>, existing: readonly { readonly ref: { readonly entityType: string; readonly stableId: string } }[]) => {
    const types = new Map([...existing, ...addition.nodes].map((node) => [node.ref.stableId, node.ref.entityType] as const));
    return addition.edges.every((edge) => {
      const from = 'entityType' in edge.from ? types.get(edge.from.stableId) : undefined;
      const to = 'entityType' in edge.to ? types.get(edge.to.stableId) : undefined;
      return profile.relationshipTypes.some((relationship) => !relationship.aggregate && relationship.type === edge.type && relationship.from === from && relationship.to === to);
    });
  };

  it.each([
    ['the test profile', testProfile()],
    ['a profile with four entity types, a relationship between an entity type and itself and an aggregate one', richProfile()],
  ])('joins each added entity only by a stored relationship whose two ends are of the types of the two entities: %s', (_name, profile) => {
    const base = generateFixtureGraph(profile, 1);
    const addition = generateAddition(profile, base.nodes, 25, 0);
    expect(addition.nodes).toHaveLength(25);
    expect(addition.edges.length).toBeGreaterThan(0);
    expect(endpointsFit(profile, addition, base.nodes)).toBe(true);
    const again = generateAddition(profile, [...base.nodes, ...addition.nodes], 25, 1);
    expect(endpointsFit(profile, again, [...base.nodes, ...addition.nodes])).toBe(true);
  });

  it('passes over an entity type that no stored relationship can join, and adds no entity of it', () => {
    const base = generateFixtureGraph(testProfile(), 1);
    const addition = generateAddition(testProfile(), base.nodes, 25, 0);
    expect(addition.nodes.every((node) => node.ref.entityType !== 'kind-c')).toBe(true);
  });

  it('is refused, with nothing made, when no stored relationship can join any entity type to a loaded entity', () => {
    const profile = { ...testProfile(), relationshipTypes: testProfile().relationshipTypes.map((relationship) => ({ ...relationship, aggregate: true })) };
    const base = generateFixtureGraph(testProfile(), 1);
    expect(() => generateAddition(profile, base.nodes, 5, 0)).toThrowError(expect.objectContaining({ code: 'NO_RELATIONSHIP_TYPES' }));
    expect(() => generateAddition(richProfile(), [], 5, 0)).toThrowError(expect.objectContaining({ code: 'NO_RELATIONSHIP_TYPES' }));
  });

  it('is the same for the same profile, entities and round, and different for another round', () => {
    const base = generateFixtureGraph(testProfile(), 1);
    expect(generateAddition(testProfile(), base.nodes, 25, 0)).toEqual(generateAddition(testProfile(), base.nodes, 25, 0));
    expect(generateAddition(testProfile(), base.nodes, 25, 0).edges).not.toEqual(generateAddition(testProfile(), base.nodes, 25, 1).edges);
  });
});
