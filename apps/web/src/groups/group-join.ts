import type { GraphNode } from '@neburyx/contracts';
import { elementKey, nodeRefOfKey } from '../state/keys.js';
import { BY_ENTITY_TYPE, type Group } from './group-model.js';

/**
 * The groups after entities were added to the view: an added entity joins the entity-type group of its type only when that group held every entity of the type that was loaded before; a group made from a selection or from the node menu holds only some of them and is not joined, and a grouping by a property or by component is left as it was.
 */
export function joinedGroups(groups: readonly Group[], before: readonly GraphNode[], after: readonly GraphNode[]): readonly Group[] {
  if (before.length === 0) return groups;
  const known = new Set(before.map((node) => elementKey(node.ref)));
  const added = after.filter((node) => !known.has(elementKey(node.ref)));
  if (added.length === 0) return groups;
  let next = groups;
  for (const group of groups) {
    if (group.by !== BY_ENTITY_TYPE) continue;
    const type = nodeRefOfKey(group.members[0] ?? '')?.entityType;
    if (type === undefined) continue;
    const held = new Set(group.members);
    const loadedOfType = before.filter((node) => node.ref.entityType === type).map((node) => elementKey(node.ref));
    if (loadedOfType.length === 0 || !loadedOfType.every((key) => held.has(key))) continue;
    const joining = added.filter((node) => node.ref.entityType === type).map((node) => elementKey(node.ref));
    if (joining.length === 0) continue;
    next = next.map((candidate) => (candidate.id === group.id ? { ...candidate, members: [...candidate.members, ...joining] } : candidate));
  }
  return next;
}
