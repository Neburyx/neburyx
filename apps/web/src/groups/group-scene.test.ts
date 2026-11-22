import { describe, expect, it } from 'vitest';
import { buildScene } from '../canvas/build-scene.js';
import { BOX_HEIGHT, BOX_WIDTH } from '../canvas/layout-constants.js';
import type { Scene } from '../canvas/scene.js';
import { entityOf, graphOf, keyOf, linkOf, profileWith, at } from './group-kit.js';
import { groupsByEntityType, type Group } from './group-model.js';
import { groupScene } from './group-scene.js';
import { cardKey } from './group-keys.js';

const devices = [entityOf('kind-d', 'DV1'), entityOf('kind-d', 'DV2')];
const accounts = [entityOf('kind-a', 'A1'), entityOf('kind-a', 'A2')];
const kindC = entityOf('kind-c', 'C1');
const all = [...devices, ...accounts, kindC];
const profile = profileWith({ 'kind-d': { name: 'Kind D' }, 'kind-a': { name: 'Kind A' }, 'kind-c': { name: 'Kind C' } });

function sceneOf(nodes = all, edges = [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 1), at(devices, 1)), linkOf('L3', kindC, at(accounts, 0))], hiddenKeys: readonly string[] = []) {
  const graph = graphOf(nodes.filter((node) => !hiddenKeys.includes(keyOf(node))), edges);
  const positions = new Map(nodes.map((node, index) => [keyOf(node), { x: index * 400, y: index * 10 }]));
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
    expect(card?.position).toEqual({ x: 200, y: 5 });
    expect(grouped.entities.map((entity) => entity.id)).not.toContain(keyOf(at(devices, 0)));
    expect(grouped.entities).toHaveLength(all.length - 2 + 1);
  });

  it('moves a card that would sit on another entity to the nearest free place, and keeps it clear of other cards', () => {
    const near = sceneOf(all, undefined, []);
    const crowded = { ...near.scene, entities: near.scene.entities.map((entity, index) => ({ ...entity, position: { x: index * 20, y: 0 } })) };
    const grouped = groupScene(crowded, near.graph, groupsByEntityType(all).map((group) => ({ ...group, collapsed: true })), profile);
    const cards = grouped.entities.filter((entity) => entity.group !== undefined).map((entity) => entity.position);
    expect(cards).toHaveLength(3);
    for (const [index, card] of cards.entries()) for (const other of cards.slice(index + 1)) expect(Math.hypot(card.x - other.x, card.y - other.y)).toBeGreaterThan(50);
    const kept = grouped.entities.filter((entity) => entity.group === undefined).map((entity) => entity.position);
    for (const card of cards) for (const place of kept) expect(Math.abs(card.x - place.x) >= BOX_WIDTH || Math.abs(card.y - place.y) >= BOX_HEIGHT).toBe(true);
  });

  it('keeps a free card a line\'s length from the nearest entity, so that the chip between them can be read', () => {
    const near = sceneOf(all, undefined, []);
    const placed = { ...near.scene, entities: near.scene.entities.map((entity, index) => ({ ...entity, position: { x: index * 400, y: 0 } })) };
    const grouped = groupScene(placed, near.graph, [groupOf('type:kind-d', devices, true)], profile);
    const card = grouped.entities.find((entity) => entity.group !== undefined)?.position;
    const rest = grouped.entities.filter((entity) => entity.group === undefined).map((entity) => entity.position);
    expect(card).toBeDefined();
    for (const place of rest) expect(Math.hypot((card?.x ?? 0) - place.x, (card?.y ?? 0) - place.y)).toBeGreaterThanOrEqual(150);
  });

  it('merges source aggregates that stand for exactly one relationship each, and leaves one that stands for more unmerged', () => {
    const edges = [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 0), at(devices, 1)), linkOf('L3', at(accounts, 1), at(devices, 1))];
    const { graph, scene } = sceneOf(all, edges);
    const asAggregates = { ...scene, relationships: scene.relationships.map((relationship) => ({ ...relationship, look: { ...relationship.look, aggregate: true, ...(relationship.id.includes('L3') ? { badge: '≥ 3 · lower bound' } : { single: true as const }) } })) };
    const grouped = groupScene(asAggregates, graph, [groupOf('type:kind-d', devices, true)], profile);
    expect(grouped.relationships.map((relationship) => relationship.look.label)).toEqual(expect.arrayContaining([undefined, '×2']));
    expect(grouped.relationships.find((relationship) => relationship.look.label === undefined)?.look.badge).toBe('≥ 3 · lower bound');
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

  it('draws no caption on a relationship that ends at a card (its name stays in the hover tip) and only the chip of a merged one', () => {
    const edges = [linkOf('L1', at(accounts, 0), at(devices, 0)), linkOf('L2', at(accounts, 0), at(devices, 1)), linkOf('L3', at(accounts, 1), at(devices, 1), { type: 'other' }), linkOf('L5', kindC, at(accounts, 0))];
    const { graph, scene } = sceneOf(all, edges);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, true)], profile);
    const atCard = grouped.relationships.filter((relationship) => relationship.from === cardKey('type:kind-d') || relationship.to === cardKey('type:kind-d'));
    expect(atCard.map((relationship) => relationship.look.label)).toEqual(expect.arrayContaining([undefined, '×2']));
    expect(atCard).toHaveLength(2);
    expect(atCard.find((relationship) => relationship.look.label === undefined)?.look.tip).toBeTruthy();
    const untouched = grouped.relationships.find((relationship) => relationship.from === keyOf(kindC));
    expect(untouched?.look.label).toBeTruthy();
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
  });

  it('draws an expanded group as its drawn members only: no card, no container, nothing added to the scene', () => {
    const { graph, scene } = sceneOf(all, undefined, [keyOf(at(devices, 0))]);
    const grouped = groupScene(scene, graph, [groupOf('type:kind-d', devices, false)], profile);
    expect(grouped).not.toHaveProperty('containers');
    expect(grouped.entities.some((entity) => entity.group !== undefined)).toBe(false);
    expect(grouped.entities.map((entity) => entity.id)).toContain(keyOf(at(devices, 1)));
  });

  it('draws the groups the model makes as the members they hold until a group is collapsed, and then only a card for each collapsed one', () => {
    const { graph, scene } = sceneOf();
    const made = groupsByEntityType(all);
    expect(groupScene(scene, graph, made, profile).entities).toHaveLength(all.length);
    const grouped = groupScene(scene, graph, made.map((group) => ({ ...group, collapsed: true })), profile);
    expect(grouped.entities.filter((entity) => entity.group !== undefined)).toHaveLength(3);
    expect(grouped.entities.every((entity) => entity.group !== undefined)).toBe(true);
  });
});
