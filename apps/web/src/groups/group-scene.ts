import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import type { RelationshipLook } from '../canvas/relationship-look.js';
import type { Position } from '../state/presentation-state.js';
import type { Scene, SceneEntity, SceneRelationship } from '../canvas/scene.js';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { BY_ENTITY_TYPE, groupName, type Group } from './group-model.js';
import { clearOfFixed } from '../canvas/incremental-layout.js';
import { cardKey, mergedKey } from './group-keys.js';

const LOADED = (count: number): string => `${count} loaded`;
const NAME_FALLBACK = 'Group';

const CARD_CLEARANCE = 170;

/** The place moved straight away from the nearest of the others until it is `CARD_CLEARANCE` from it, so that the line between a card and its neighbour is long enough for its chip. */
function awayFrom(place: Position, others: readonly Position[]): Position {
  let nearest: Position | undefined;
  for (const other of others) if (nearest === undefined || Math.hypot(other.x - place.x, other.y - place.y) < Math.hypot(nearest.x - place.x, nearest.y - place.y)) nearest = other;
  if (nearest === undefined) return place;
  const distance = Math.hypot(place.x - nearest.x, place.y - nearest.y);
  if (distance >= CARD_CLEARANCE) return place;
  const [dx, dy] = distance === 0 ? [0, 1] : [(place.x - nearest.x) / distance, (place.y - nearest.y) / distance];
  return { x: nearest.x + dx * CARD_CLEARANCE, y: nearest.y + dy * CARD_CLEARANCE };
}

/** A relationship that ends at a card keeps its line and carries its name only in the tip, and its count with the quality label when it is an aggregate (the badge): the captions of several lines between the same two ends would sit on each other and on the cards, and the chip of a merged relationship is the only caption the frame shows. */
function withoutCaption(look: RelationshipLook): RelationshipLook {
  const { label, ...rest } = look;
  const tip = look.tip ?? label;
  return { ...rest, label: undefined, ...(tip === undefined ? {} : { tip }) };
}

/** The scene with its groups applied: a collapsed group is one card at the centre of its drawn members (moved to the nearest free place when that would put it on another entity or card), its members and the relationships between them are not drawn, the relationships to it are drawn from the card and merged as the rule of the feature says, and an expanded group is its members as they are. Nothing is written to the state: the members keep their places. */
export function groupScene(scene: Scene, graph: LoadedGraph, groups: readonly Group[], profile: SourceProfile | undefined): Scene {
  if (groups.length === 0) return scene;
  const nodes = new Map<string, GraphNode>(graph.nodes.map((node) => [elementKey(node.ref), node]));
  const drawn = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const collapsedOf = new Map<string, Group>();
  for (const group of groups) if (group.collapsed) for (const member of group.members) if (!collapsedOf.has(member)) collapsedOf.set(member, group);

  const cards = new Map<string, SceneEntity>();
  for (const group of groups) {
    if (!group.collapsed) continue;
    const visible = group.members.map((member) => drawn.get(member)).filter((entity): entity is SceneEntity => entity !== undefined && collapsedOf.get(entity.id) === group);
    if (visible.length === 0) continue;
    const centre = { x: visible.reduce((sum, entity) => sum + entity.position.x, 0) / visible.length, y: visible.reduce((sum, entity) => sum + entity.position.y, 0) / visible.length };
    const type = group.by === BY_ENTITY_TYPE ? nodes.get(group.members[0] ?? '')?.ref.entityType : undefined;
    const iconKey = (type === undefined ? undefined : profile?.entityTypes.find((entry) => entry.type === type)?.icon) ?? 'generic';
    const name = groupName(group, nodes, profile) ?? NAME_FALLBACK;
    cards.set(group.id, { id: cardKey(group.id), position: centre, look: { iconKey, line1: name, line2: LOADED(group.members.length) }, group: { id: group.id, count: group.members.length } });
  }
  const kept = scene.entities.filter((entity) => !collapsedOf.has(entity.id));
  const fixed = new Map(kept.map((entity) => [entity.id, entity.position]));
  const apart = new Map([...cards].map(([id, card]) => [id, awayFrom(card.position, [...fixed.values()])]));
  const cleared = clearOfFixed([...cards.keys()], apart, fixed);
  for (const [id, card] of cards) cards.set(id, { ...card, position: cleared.get(id) ?? card.position });
  const representative = (key: string): string => {
    const group = collapsedOf.get(key);
    return group === undefined ? key : (cards.get(group.id)?.id ?? key);
  };
  const hiddenByGroup = (key: string): boolean => collapsedOf.has(key);

  // an aggregate node ("not loaded") of a collapsed member goes with it
  const goneAggregates = new Set<string>();
  for (const relationship of scene.relationships) if (relationship.remainder === true && hiddenByGroup(relationship.from)) goneAggregates.add(relationship.to);
  const entities: SceneEntity[] = [...scene.entities.filter((entity) => !hiddenByGroup(entity.id) && !goneAggregates.has(entity.id)), ...cards.values()];

  const merged = new Map<string, SceneRelationship[]>();
  const relationships: SceneRelationship[] = [];
  for (const relationship of scene.relationships) {
    if (relationship.remainder === true) {
      if (!hiddenByGroup(relationship.from)) relationships.push(relationship);
      continue;
    }
    const from = representative(relationship.from);
    const to = representative(relationship.to);
    if (from === to && from !== relationship.from) continue;
    if (from === relationship.from && to === relationship.to) {
      relationships.push(relationship);
      continue;
    }
    if (relationship.look.aggregate && relationship.look.single !== true) {
      relationships.push({ ...relationship, from, to, look: withoutCaption(relationship.look) });
      continue;
    }
    const mergeKey = JSON.stringify([from, to, relationship.look.label, relationship.look.origin]);
    merged.set(mergeKey, [...(merged.get(mergeKey) ?? []), { ...relationship, from, to }]);
  }
  for (const [mergeKey, held] of merged) {
    const [first] = held;
    if (first === undefined) continue;
    if (held.length === 1) {
      relationships.push({ ...first, look: withoutCaption(first.look) });
      continue;
    }
    const count = `×${held.length}`;
    relationships.push({ id: mergedKey([mergeKey]), from: first.from, to: first.to, look: { aggregate: true, origin: first.look.origin, label: count, badge: count, tip: `${first.look.label ?? ''} ${count}`.trim(), ...(held.some((entry) => entry.look.touched === true) ? { touched: true as const } : {}) } });
  }

  const focused = scene.focused !== undefined && hiddenByGroup(scene.focused) ? undefined : scene.focused;
  return { ...scene, entities, relationships, ...(scene.focused === undefined ? {} : { focused }) };
}
