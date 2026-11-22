import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';

/** A group of loaded entities: a descriptor of how it was made and the keys of its members, never a value of a property. */
export interface Group {
  readonly id: string;
  /** `entityType`, `property:<key>` or `component`. */
  readonly by: string;
  readonly members: readonly string[];
  readonly collapsed: boolean;
}

export const BY_ENTITY_TYPE = 'entityType';
export const BY_COMPONENT = 'component';
const PROPERTY_PREFIX = 'property:';
const TYPE_ID_PREFIX = 'type:';
const PROPERTY_ID_PREFIX = 'property:';
const COMPONENT_ID_PREFIX = 'component:';

/** Whether a grouping descriptor is one this client knows. */
export const isKnownGrouping = (by: string): boolean => by === BY_ENTITY_TYPE || by === BY_COMPONENT || (by.startsWith(PROPERTY_PREFIX) && by.length > PROPERTY_PREFIX.length);

export const propertyBy = (key: string): string => `${PROPERTY_PREFIX}${key}`;
export const propertyKeyOf = (by: string): string | undefined => (by.startsWith(PROPERTY_PREFIX) ? by.slice(PROPERTY_PREFIX.length) : undefined);

type Scalar = string | number | boolean;
const scalarOf = (value: unknown): Scalar | undefined => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined);
const sameValueKey = (value: Scalar): string => `${typeof value}:${String(value)}`;

/** One collapsed group for each entity type among the nodes, in the order the types first appear. */
export function groupsByEntityType(nodes: readonly GraphNode[], idOf: (type: string) => string = (type) => `${TYPE_ID_PREFIX}${type}`): Group[] {
  const members = new Map<string, string[]>();
  for (const node of nodes) members.set(node.ref.entityType, [...(members.get(node.ref.entityType) ?? []), elementKey(node.ref)]);
  return [...members].map(([type, keys]) => ({ id: idOf(type), by: BY_ENTITY_TYPE, members: keys, collapsed: true }));
}

export interface Grouping {
  readonly groups: Group[];
  /** How many of the nodes are in no group. */
  readonly left: number;
}

/** One collapsed group for each distinct scalar value of the property among the nodes that carry it; the group's id holds the order the values first appear in, never a value. */
export function groupsByProperty(nodes: readonly GraphNode[], key: string): Grouping {
  const byValue = new Map<string, string[]>();
  let left = 0;
  for (const node of nodes) {
    const value = scalarOf(node.properties.find((property) => property.key === key)?.value);
    if (value === undefined) {
      left += 1;
      continue;
    }
    const valueKey = sameValueKey(value);
    byValue.set(valueKey, [...(byValue.get(valueKey) ?? []), elementKey(node.ref)]);
  }
  return { groups: [...byValue.values()].map((keys, index) => ({ id: `${PROPERTY_ID_PREFIX}${key}:${index + 1}`, by: propertyBy(key), members: keys, collapsed: true })), left };
}

/** The order of keys by code unit, the same on every machine. */
const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One collapsed group for each connected component of the loaded drawable relationships (direction ignored) with at least one relationship, numbered by the smallest element key of each. */
export function groupsByComponent(graph: LoadedGraph): Grouping {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(key, root);
    return root;
  };
  for (const node of graph.nodes) parent.set(elementKey(node.ref), elementKey(node.ref));
  const joined = new Set<string>();
  for (const edge of partitionEdges(graph).drawable) {
    const from = elementKey(edge.from);
    const to = elementKey(edge.to);
    joined.add(from);
    joined.add(to);
    parent.set(find(from), find(to));
  }
  const components = new Map<string, string[]>();
  for (const key of [...joined].sort(codeUnitOrder)) components.set(find(key), [...(components.get(find(key)) ?? []), key]);
  const ordered = [...components.values()].sort((a, b) => codeUnitOrder(a[0] ?? '', b[0] ?? ''));
  return { groups: ordered.map((keys, index) => ({ id: `${COMPONENT_ID_PREFIX}${index + 1}`, by: BY_COMPONENT, members: keys, collapsed: true })), left: graph.nodes.length - joined.size };
}

/** The mapped properties that may be grouped by: those of the entity types in the view; while masking is on, not one that any of those types marks `pii`, and not one a loaded entity carries masked by a policy. */
export function eligibleProperties(profile: SourceProfile | undefined, graph: LoadedGraph, masking: boolean): readonly string[] | undefined {
  if (profile === undefined) return undefined;
  const present = new Set(graph.nodes.map((node) => node.ref.entityType));
  const types = profile.entityTypes.filter((entry) => present.has(entry.type));
  const sensitive = new Set(masking ? types.flatMap((entry) => entry.pii) : []);
  const byPolicy = new Set(graph.nodes.flatMap((node) => node.properties.filter((property) => property.maskedBy === 'policy').map((property) => property.key)));
  return [...new Set(types.flatMap((entry) => entry.properties))].filter((key) => !sensitive.has(key) && !byPolicy.has(key));
}

/** The name a group is drawn with: the display name of its entity type, the current value of its property when every member shares one, or "Component n"; undefined when a property group's members share no current value. */
export function groupName(group: Group, nodes: ReadonlyMap<string, GraphNode>, profile: SourceProfile | undefined): string | undefined {
  if (group.by === BY_ENTITY_TYPE) {
    const type = nodes.get(group.members[0] ?? '')?.ref.entityType;
    return type === undefined ? undefined : (profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type);
  }
  if (group.by === BY_COMPONENT) return `Component ${group.id.slice(COMPONENT_ID_PREFIX.length)}`;
  const key = propertyKeyOf(group.by);
  if (key === undefined) return undefined;
  const values = new Set(group.members.map((member) => scalarOf(nodes.get(member)?.properties.find((property) => property.key === key)?.value)).map((value) => (value === undefined ? undefined : sameValueKey(value))));
  if (values.size !== 1 || values.has(undefined)) return undefined;
  return String(scalarOf(nodes.get(group.members[0] ?? '')?.properties.find((property) => property.key === key)?.value));
}

export interface PanelRow {
  readonly group: Group;
  readonly name: string;
  readonly loaded: number;
}

export interface PanelList {
  readonly rows: readonly PanelRow[];
  /** The groups folded into the "Other types" row, when there are more type rows than the panel lists. */
  readonly other: readonly PanelRow[];
}

/** The number of type rows the panel lists before it folds the rest, as frame 04f shows. */
const PANEL_TYPE_ROWS = 4;

/** The rows of the panel: largest loaded count first, ties by name; for groups by entity type the first `PANEL_TYPE_ROWS` are rows and the rest are folded, and groups by property or component are all listed. */
export function panelList(groups: readonly Group[], nodes: ReadonlyMap<string, GraphNode>, profile: SourceProfile | undefined): PanelList {
  const rows = groups.flatMap((group) => {
    const name = groupName(group, nodes, profile);
    return name === undefined ? [] : [{ group, name, loaded: group.members.length }];
  });
  rows.sort((a, b) => b.loaded - a.loaded || a.name.localeCompare(b.name));
  const byType = rows.every((row) => row.group.by === BY_ENTITY_TYPE);
  return !byType || rows.length <= PANEL_TYPE_ROWS ? { rows, other: [] } : { rows: rows.slice(0, PANEL_TYPE_ROWS), other: rows.slice(PANEL_TYPE_ROWS) };
}

/** The groups with the members of `moved` taken out of every group they were in and put into `target` (a group that is left empty is dropped). */
export function withMoved(groups: readonly Group[], target: Group): Group[] {
  const taken = new Set(target.members);
  const rest = groups.filter((group) => group.id !== target.id).map((group) => ({ ...group, members: group.members.filter((member) => !taken.has(member)) })).filter((group) => group.members.length > 0);
  return [...rest, target];
}
