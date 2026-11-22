import type { GraphNode, IconKey, SourceProfile } from '@neburyx/contracts';
import { styleLookOf, type StyleLook } from './style-look.js';
import { isNotReadNode, isUnmappedNode, NO_LONGER_MAPPED, SAVED_LAYOUT_NOT_READ, UNMAPPED_TITLE } from '../draft/unmapped.js';

export interface EntityLook {
  readonly iconKey: IconKey;
  readonly line1: string;
  readonly line2: string;
  /** What the hover tip says instead of the two caption lines, when they are short for the room they have. */
  readonly tip?: { readonly title: string; readonly detail: string };
  /** The look the node's style rules give it; absent for a node none of them gives a look. */
  readonly style?: StyleLook;
}

/** What the hover tip and the spoken description call the rules that gave a node its look. */
export const STYLE_TIP_LABEL = 'Style';

function stateOf(node: GraphNode, stateProperty: string | null): string | undefined {
  if (stateProperty === null) return undefined;
  const value = node.properties.find((property) => property.key === stateProperty)?.value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** Line 1 is the title; line 2 is the type's display name and, when the entity has one, its state. A type the profile does not list shows the generic icon and the raw type name. */
export function entityLook(node: GraphNode, profile: SourceProfile | undefined): EntityLook {
  if (isNotReadNode(node)) return { iconKey: 'generic', line1: profile?.entityTypes.find((entry) => entry.type === node.ref.entityType)?.displayName ?? UNMAPPED_TITLE, line2: SAVED_LAYOUT_NOT_READ };
  if (isUnmappedNode(node)) return { iconKey: 'generic', line1: UNMAPPED_TITLE, line2: NO_LONGER_MAPPED };
  const type = profile?.entityTypes.find((entry) => entry.type === node.ref.entityType);
  const typeName = type?.displayName ?? node.ref.entityType;
  const state = stateOf(node, type?.stateProperty ?? null);
  const line2 = state === undefined ? typeName : `${typeName} · ${state}`;
  const style = styleLookOf(node, profile);
  const base = { iconKey: style?.icon ?? type?.icon ?? 'generic', line1: node.display.title, line2 };
  return style === undefined ? base : { ...base, style, tip: { title: node.display.title, detail: `${line2}\n${STYLE_TIP_LABEL}: ${style.labels.join(', ')}` } };
}
