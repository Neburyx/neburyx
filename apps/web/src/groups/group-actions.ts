import type { SourceProfile } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { elementKey, nodeRefOfKey } from '../state/keys.js';
import { eligibleProperties, groupsByComponent, groupsByEntityType, groupsByProperty, withMoved, type Grouping } from './group-model.js';

/** What a grouping left out, for the panel to say. */
export type Applied = { readonly applied: true; readonly left: number } | { readonly applied: false; readonly reason: 'nothing-loaded' | 'no-group' | 'ineligible' };

const loadedNodes = (state: ClientState) => state.loadedGraph().nodes;

function apply(state: ClientState, grouping: Grouping): Applied {
  if (grouping.groups.length === 0) return { applied: false, reason: 'no-group' };
  state.presentation.setGroups(grouping.groups);
  return { applied: true, left: grouping.left };
}

/** Groups every loaded entity by its entity type, replacing every group; each group starts expanded. */
export function groupAllByType(state: ClientState): Applied {
  const nodes = loadedNodes(state);
  if (nodes.length === 0) return { applied: false, reason: 'nothing-loaded' };
  return apply(state, { groups: groupsByEntityType(nodes), left: 0 });
}

/** Groups every loaded entity of one type into its group, taking them out of any other group and leaving the other groups as they are. */
export function groupTypeOnly(state: ClientState, entityType: string): void {
  const nodes = loadedNodes(state).filter((node) => node.ref.entityType === entityType);
  const [made] = groupsByEntityType(nodes);
  if (made === undefined) return;
  const groups = state.presentation.view.getState().groups;
  const held = groups.find((group) => group.id === made.id);
  if (held !== undefined && held.members.length === made.members.length && made.members.every((member) => held.members.includes(member))) return;
  state.presentation.setGroups(withMoved(groups, made));
}

const SELECTION_ID_PREFIX = 'selection:';

/** The id of a group made from a selection: its own, so that the members it does not take stay in the group they were in. */
function selectionGroupId(groups: readonly { readonly id: string }[], type: string): string {
  const prefix = `${SELECTION_ID_PREFIX}${type}:`;
  const highest = Math.max(0, ...groups.flatMap((group) => (group.id.startsWith(prefix) ? [Number(group.id.slice(prefix.length))] : [])).filter(Number.isInteger));
  return `${prefix}${highest + 1}`;
}

/** Groups the selected entities by entity type (relationships in the selection are ignored): each type among them becomes one group (expanded), its members taken out of any other group. */
export function groupSelection(state: ClientState, selection: readonly string[]): void {
  const wanted = new Set(selection.filter((key) => nodeRefOfKey(key) !== undefined));
  const nodes = loadedNodes(state).filter((node) => wanted.has(elementKey(node.ref)));
  let groups = state.presentation.view.getState().groups;
  for (const made of groupsByEntityType(nodes, (type) => selectionGroupId(groups, type))) groups = withMoved(groups, made);
  state.presentation.setGroups(groups);
}

export function groupByProperty(state: ClientState, key: string, profile: SourceProfile | undefined): Applied {
  const nodes = loadedNodes(state);
  if (nodes.length === 0) return { applied: false, reason: 'nothing-loaded' };
  if (eligibleProperties(profile, state.loadedGraph(), state.mask.getState())?.includes(key) !== true) return { applied: false, reason: 'ineligible' };
  return apply(state, groupsByProperty(nodes, key));
}

export function groupByComponent(state: ClientState): Applied {
  if (state.loadedGraph().nodes.length === 0) return { applied: false, reason: 'nothing-loaded' };
  return apply(state, groupsByComponent(state.loadedGraph()));
}

export function ungroupAll(state: ClientState): void {
  state.presentation.setGroups([]);
}
