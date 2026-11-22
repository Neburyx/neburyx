import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { elementKey, nodeRefOfKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { groupName, propertyKeyOf, type Group } from './group-model.js';

export type GuardNote = 'masked' | 'values' | 'profile';

export interface GuardInput {
  readonly groups: readonly Group[];
  readonly graph: LoadedGraph;
  /** The profile once it is known; undefined while it is being read or when it could not be. */
  readonly profile: SourceProfile | undefined;
  /** True when the profile could not be read, so a grouping by a property cannot be judged. */
  readonly profileFailed: boolean;
  readonly masking: boolean;
  /** The view is being read again: what is loaded is not the view, so only the descriptor and the profile are judged. */
  readonly rereading: boolean;
}

export interface GuardOutcome {
  readonly groups: readonly Group[];
  /** What the person is told when a grouping was removed; the first reason met. */
  readonly note: GuardNote | undefined;
}

function reasonToRemove(group: Group, input: GuardInput, nodes: ReadonlyMap<string, GraphNode>): GuardNote | undefined {
  const key = propertyKeyOf(group.by);
  if (key === undefined) return undefined;
  if (input.profileFailed) return 'profile';
  if (input.profile === undefined) return undefined;
  const types = new Set([...group.members.flatMap((member) => nodeRefOfKey(member)?.entityType ?? []), ...(input.rereading ? [] : input.graph.nodes.map((node) => node.ref.entityType))]);
  const present = input.profile.entityTypes.filter((entry) => types.has(entry.type));
  if (input.masking && present.some((entry) => entry.pii.includes(key))) return 'masked';
  if (input.rereading) return undefined;
  if (input.graph.nodes.some((node) => node.properties.some((property) => property.key === key && property.maskedBy === 'policy'))) return 'masked';
  const memberTypes = new Set(group.members.flatMap((member) => nodeRefOfKey(member)?.entityType ?? []));
  if (!input.profile.entityTypes.some((entry) => memberTypes.has(entry.type) && entry.properties.includes(key))) return 'values';
  const loaded = group.members.filter((member) => nodes.has(member));
  if (loaded.length === group.members.length && groupName(group, nodes, input.profile) === undefined) return 'values';
  return undefined;
}

/** The groups that may stand now: a grouping by a property is removed when the property is marked `pii` for a type of its members while masking is on, a policy masks it, the mapping no longer names it, its members no longer share one value, or the profile cannot be read; the other groupings are untouched. */
export function guardedGroups(input: GuardInput): GuardOutcome {
  const nodes = new Map(input.graph.nodes.map((node) => [elementKey(node.ref), node]));
  let note: GuardNote | undefined;
  const kept = input.groups.filter((group) => {
    const reason = reasonToRemove(group, input, nodes);
    if (reason !== undefined && note === undefined) note = reason;
    return reason === undefined;
  });
  return { groups: kept.length === input.groups.length ? input.groups : kept, note };
}
