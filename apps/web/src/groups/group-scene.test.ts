import { describe, expect, it } from 'vitest';
import { buildScene } from '../canvas/build-scene.js';
import type { Scene } from '../canvas/scene.js';
import { entityOf, graphOf, keyOf, linkOf, profileWith, at } from './group-kit.js';
import { groupsByEntityType, type Group } from './group-model.js';
import { groupScene } from './group-scene.js';
import { cardKey, containerKey } from './group-keys.js';

const devices = [entityOf('kind-d', 'DV1'), entityOf('kind-d', 'DV2')];
const accounts = [entityOf('kind-a', 'A1'), entityOf('kind-a', 'A2')];
const kindC = entityOf('kind-c', 'C1');
const all = [...devices, ...accounts, kindC];
const profile = profileWith({ 'kind-d': { name: 'Kind D' }, 'kind-a': { name: 'Kind A' }, 'kind-c': { name: 'Kind C' } });

function sceneOf(nodes = all, edges = [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 1), at(devices, 1)), linkOf('L3', kindC, at(accounts, 0))], hiddenKeys: readonly string[] = []) {
  const graph = graphOf(nodes.filter((node) => !hiddenKeys.includes(keyOf(node))), edges);
  const positions = new Map(nodes.map((node, index) => [keyOf(node), { x: index * 100, y: index * 10 }]));
  return { graph: graphOf(nodes, edges), scene: buildScene(graph, positions, profile, new Set(), 'select', 'a') as Scene };
}

const groupOf = (id: string, members: readonly ReturnType<typeof entityOf>[], collapsed: boolean, by = 'entityType'): Group => ({ id, by, members: members.map(keyOf), collapsed });

describe('a scene with groups', () => {
  it('is the scene as it is without groups', () => {
    const { graph, scene } = sceneOf();
    expect(groupScene(scene, graph, [], profile)).toBe(scene);
  });

  it('draws a collapsed group as one card at the centre of its members, named by the profile and counting its loaded members, and draws no member', () => {
    const { graph, scene } = sceneOf();
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, true)], profile);
    const card = grouped.entities.find((entity) => entity.id === cardKey('type:kind-d'));
    expect(card?.look).toMatchObject({ line1: 'Kind D', line2: '2 loaded' });
    expect(card?.group).toEqual({ id: 'type:kind-d', count: 2 });
    expect(card?.look.iconKey).toBe(profile.entityTypes.find((entry) => entry.type === 'kind-d')?.icon);
    expect(card?.position).toEqual({ x: 50, y: 5 });
    expect(grouped.entities.map((entity) => entity.id)).not.toContain(keyOf(at(devices, 0)));
    expect(grouped.entities).toHaveLength(all.length - 2 + 1);
  });

  it('draws the card of a group by a property or by component with the generic icon', () => {
    const { graph, scene } = sceneOf();
    const grouped = groupScene(scene, graph, [groupOf('property:currency:1', devices, true, 'property:currency'), groupOf('component:1', accounts, true, 'component')], profile);
    expect(grouped.entities.filter((entity) => entity.group !== undefined).map((entity) => entity.look.iconKey)).toEqual(['generic', 'generic']);
  });

  it('draws the relationship of a member as one from the card, merges those of the same type, direction and origin into a counted one and drops those inside a group', () => {
    const { graph, scene } = sceneOf(all, [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 0), at(devices, 1)), linkOf('L3', at(devices, 0), at(devices, 1))]);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, true)], profile);
    const card = cardKey('type:kind-d');
    expect(grouped.relationships).toHaveLength(1);
    const [only] = grouped.relationships;
    expect(only).toMatchObject({ from: keyOf(at(accounts, 0)), to: card, look: { aggregate: true, label: '×2', badge: '×2' } });
  });

  it('keeps reciprocal, differently typed and differently originated relationships apart', () => {
    const edges = [
      linkOf('L1', at(accounts, 0), at(devices, 0)),
      linkOf('L2', at(devices, 1), at(accounts, 0)),
      linkOf('L3', at(accounts, 0), at(devices, 1), { type: 'other' }),
      linkOf('L4', at(accounts, 0), at(devices, 1), { semantics: 'derived' }),
    ];
    const { graph, scene } = sceneOf(all, edges);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, true)], profile);
    expect(grouped.relationships).toHaveLength(4);
    expect(grouped.relationships.every((relationship) => relationship.look.aggregate === false)).toBe(true);
  });

  it('merges the relationships between two collapsed groups, and leaves a source aggregate unmerged', () => {
    const aggregate = linkOf('AG', at(accounts, 1), at(devices, 0), { ref: { sourceId: 'a', aggregate: { type: 'rel-a', from: at(accounts, 1).ref, to: at(devices, 0).ref } } });
    const { graph, scene } = sceneOf(all, [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 1), at(devices, 1)), aggregate]);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, true), groupOf('type:kind-a', accounts, true)], profile);
    const between = grouped.relationships.filter((relationship) => relationship.from === cardKey('type:kind-a') && relationship.to === cardKey('type:kind-d'));
    expect(between.map((relationship) => relationship.look.label)).toEqual(expect.arrayContaining(['×2']));
    expect(grouped.relationships).toHaveLength(2);
  });

  it('counts the hidden members of a group, draws no card when every member is hidden, and keeps a group whose members are all hidden out of the scene', () => {
    const hiddenOne = sceneOf(all, undefined, [keyOf(at(devices, 0))]);
    const one = groupScene(hiddenOne.scene, hiddenOne.graph, [groupOf('type:kind-d', devices, true)], profile);
    expect(one.entities.find((entity) => entity.id === cardKey('type:kind-d'))?.look.line2).toBe('2 loaded');
    const hiddenAll = sceneOf(all, undefined, devices.map(keyOf));
    const none = groupScene(hiddenAll.scene, hiddenAll.graph, [groupOf('type:kind-d', devices, true)], profile);
    expect(none.entities.some((entity) => entity.group !== undefined)).toBe(false);
    expect(groupScene(hiddenAll.scene, hiddenAll.graph, [groupOf('type:kind-d', devices, false)], profile).containers).toEqual([]);
  });

  it('draws an expanded group as a container around its drawn members, labelled and counting every loaded member', () => {
    const { graph, scene } = sceneOf(all, undefined, [keyOf(at(devices, 0))]);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, false)], profile);
    expect(grouped.containers).toEqual([{ id: containerKey('type:kind-d'), label: 'Kind D · 2 loaded', members: [keyOf(at(devices, 1))] }]);
    expect(grouped.entities.map((entity) => entity.id)).toContain(keyOf(at(devices, 1)));
  });

  it('makes one group for each type with the model and draws a card for each', () => {
    const { graph, scene } = sceneOf();
    const grouped = groupScene(scene, graph, groupsByEntityType(all), profile);
    expect(grouped.entities.filter((entity) => entity.group !== undefined)).toHaveLength(3);
    expect(grouped.entities.every((entity) => entity.group !== undefined)).toBe(true);
  });
});
