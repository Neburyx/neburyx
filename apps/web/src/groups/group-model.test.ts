import { describe, expect, it } from 'vitest';
import { BY_COMPONENT, BY_ENTITY_TYPE, eligibleProperties, groupName, groupsByComponent, groupsByEntityType, groupsByProperty, panelList, propertyBy, withMoved } from './group-model.js';
import { entityOf, graphOf, keyOf, linkOf, profileWith, at } from './group-kit.js';

const byKey = (nodes: readonly ReturnType<typeof entityOf>[]) => new Map(nodes.map((entry) => [keyOf(entry), entry]));

describe('grouping by entity type', () => {
  it('makes one expanded group for each type, singletons included, with no value in it', () => {
    const nodes = [entityOf('kind-d', 'DV1'), entityOf('kind-a', 'A1'), entityOf('kind-d', 'DV2'), entityOf('kind-l', 'C1')];
    const groups = groupsByEntityType(nodes);
    expect(groups.map((group) => [group.id, group.members.length, group.collapsed, group.by])).toEqual([
      ['type:kind-d', 2, false, BY_ENTITY_TYPE],
      ['type:kind-a', 1, false, BY_ENTITY_TYPE],
      ['type:kind-l', 1, false, BY_ENTITY_TYPE],
    ]);
  });

  it('makes no group when nothing is loaded', () => {
    expect(groupsByEntityType([])).toEqual([]);
  });
});

describe('grouping by property', () => {
  const nodes = [entityOf('kind-a', 'A1', { currency: 'USD' }), entityOf('kind-a', 'A2', { currency: 'USD' }), entityOf('kind-d', 'DV1', { currency: 'EUR' }), entityOf('kind-d', 'DV2'), entityOf('kind-d', 'DV3', { currency: null }), entityOf('kind-d', 'DV4', { currency: { nested: 1 } }), entityOf('kind-l', 'C1', { currency: 1 }), entityOf('kind-l', 'C2', { currency: '1' })];

  it('makes one group for each distinct scalar value, equal by kind and value, and leaves out absent, null and non-scalar values', () => {
    const { groups, left } = groupsByProperty(nodes, 'currency');
    expect(groups.map((group) => group.members.length)).toEqual([2, 1, 1, 1]);
    expect(left).toBe(3);
  });

  it('holds no value in an id or a descriptor', () => {
    const { groups } = groupsByProperty(nodes, 'currency');
    expect(JSON.stringify(groups.map(({ id, by }) => ({ id, by })))).not.toMatch(/USD|EUR/);
    expect(groups.every((group) => group.by === propertyBy('currency'))).toBe(true);
  });

  it('names a group by the value its members share now, and by none when they share none', () => {
    const { groups } = groupsByProperty(nodes, 'currency');
    expect(groupName(at(groups, 0), byKey(nodes), undefined)).toBe('USD');
    const [first] = groups;
    const changed = byKey([entityOf('kind-a', 'A1', { currency: 'USD' }), entityOf('kind-a', 'A2', { currency: 'GBP' })]);
    expect(first && groupName(first, changed, undefined)).toBeUndefined();
  });

  it('makes no group for a property no entity carries', () => {
    expect(groupsByProperty(nodes, 'nothing')).toEqual({ groups: [], left: nodes.length });
  });
});

describe('grouping by component', () => {
  it('joins entities through loaded relationships whatever their direction, numbers components by the smallest key and leaves isolated entities out', () => {
    const [a, b, c, d, e, f] = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => entityOf('kind-a', id));
    if (!a || !b || !c || !d || !e || !f) throw new Error('fixture');
    const graph = graphOf([a, b, c, d, e, f], [linkOf('L1', a, b), linkOf('L2', c, b), linkOf('L3', d, e)]);
    const { groups, left } = groupsByComponent(graph);
    expect(groups.map((group) => group.members.map((member) => JSON.parse(member)[3]))).toEqual([['A', 'B', 'C'], ['D', 'E']]);
    expect(groups.map((group) => group.id)).toEqual(['component:1', 'component:2']);
    expect(groups.every((group) => group.by === BY_COMPONENT && !group.collapsed)).toBe(true);
    expect(left).toBe(1);
  });

  it('handles a cycle, a hidden bridge (the loaded graph is used, not the display graph) and a relationship whose end is not loaded', () => {
    const [a, b, c, outside] = ['A', 'B', 'C', 'Z'].map((id) => entityOf('kind-a', id));
    if (!a || !b || !c || !outside) throw new Error('fixture');
    const graph = graphOf([a, b, c], [linkOf('L1', a, b), linkOf('L2', b, c), linkOf('L3', c, a), linkOf('L4', c, outside)]);
    const { groups, left } = groupsByComponent(graph);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(3);
    expect(left).toBe(0);
  });

  it('orders components and members by code unit, not by locale', () => {
    const [upper, lower, other, otherLower] = ['B', 'a', 'C', 'b'].map((id) => entityOf('kind-a', id));
    if (!upper || !lower || !other || !otherLower) throw new Error('fixture');
    const graph = graphOf([upper, lower, other, otherLower], [linkOf('L1', lower, otherLower), linkOf('L2', upper, other)]);
    const { groups } = groupsByComponent(graph);
    expect(groups.map((group) => group.members.map((member) => JSON.parse(member)[3]))).toEqual([['B', 'C'], ['a', 'b']]);
  });

  it('makes no group when no relationship is loaded', () => {
    const graph = graphOf([entityOf('kind-a', 'A'), entityOf('kind-a', 'B')]);
    expect(groupsByComponent(graph)).toEqual({ groups: [], left: 2 });
  });
});

describe('the properties offered for grouping', () => {
  const graph = graphOf([entityOf('kind-a', 'A1'), entityOf('kind-d', 'DV1')]);
  const profile = profileWith({ 'kind-a': { pii: ['holder'], properties: ['holder', 'currency'] }, 'kind-d': { properties: ['holder', 'model'] }, 'kind-l': { properties: ['unseen'] } });

  it('offers the mapped properties of the types in the view, none of the other types', () => {
    expect(eligibleProperties(profile, graph, false)).toEqual(['holder', 'currency', 'model']);
  });

  it('leaves out a key that any type in the view marks pii while masking is on, though another type does not', () => {
    expect(eligibleProperties(profile, graph, true)).toEqual(['currency', 'model']);
  });

  it('leaves out a property that any loaded entity carries masked by a policy, whatever the flag says', () => {
    const policy = { ...entityOf('kind-d', 'DV2'), properties: [{ key: 'model', value: 'x', dataClass: 'text' as const, masked: true, maskedBy: 'policy' as const }] };
    expect(eligibleProperties(profile, graphOf([...graph.nodes, policy]), false)).toEqual(['holder', 'currency']);
  });

  it('knows nothing while the profile is not known', () => {
    expect(eligibleProperties(undefined, graph, false)).toBeUndefined();
  });
});

describe('the rows of the panel', () => {
  const profile = profileWith({ a: { name: 'Kind A' }, b: { name: 'Kind D' }, c: { name: 'Kind L' }, d: { name: 'Kind C' }, e: { name: 'Kind R' }, f: { name: 'Kind M' } });
  const nodes = [entityOf('a', '1'), entityOf('a', '2'), entityOf('b', '1'), entityOf('b', '2'), entityOf('c', '1'), entityOf('d', '1'), entityOf('e', '1'), entityOf('f', '1')];

  it('lists the largest type first, ties by name, four type rows, and folds the rest into the other row with their sum', () => {
    const list = panelList(groupsByEntityType(nodes), byKey(nodes), profile);
    expect(list.rows.map((row) => [row.name, row.loaded])).toEqual([['Kind A', 2], ['Kind D', 2], ['Kind C', 1], ['Kind L', 1]]);
    expect(list.other.map((row) => row.name)).toEqual(['Kind M', 'Kind R']);
    expect(list.other.reduce((sum, row) => sum + row.loaded, 0)).toBe(2);
  });

  it('lists every group by property or component as a row, with no other row', () => {
    const many = ['1', '2', '3', '4', '5', '6'].map((value) => entityOf('kind-a', `A${value}`, { currency: value }));
    const list = panelList(groupsByProperty(many, 'currency').groups.map((group) => ({ ...group })), byKey(many), profile);
    expect(list.rows).toHaveLength(6);
    expect(list.other).toEqual([]);
  });

  it('has no other row with four types or fewer', () => {
    const few = nodes.slice(0, 5);
    expect(panelList(groupsByEntityType(few), byKey(few), profile).other).toEqual([]);
  });
});

describe('moving members into a group', () => {
  it('takes them out of every other group, drops a group left empty and keeps the others', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((id) => entityOf('kind-a', id));
    if (!a || !b || !c) throw new Error('fixture');
    const groups = [{ id: 'g1', by: 'x', members: [keyOf(a), keyOf(b)], collapsed: true }, { id: 'g2', by: 'x', members: [keyOf(c)], collapsed: true }];
    const result = withMoved(groups, { id: 'g3', by: BY_ENTITY_TYPE, members: [keyOf(c), keyOf(a)], collapsed: true });
    expect(result.map((group) => [group.id, group.members.length])).toEqual([['g1', 1], ['g3', 2]]);
  });
});
