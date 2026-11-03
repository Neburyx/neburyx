import type { GraphNode, IconKey, SourceProfile } from '@neburyx/contracts';

export interface EntityLook {
  readonly iconKey: IconKey;
  readonly line1: string;
  readonly line2: string;
}

function stateOf(node: GraphNode, stateProperty: string | null): string | undefined {
  if (stateProperty === null) return undefined;
  const value = node.properties.find((property) => property.key === stateProperty)?.value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** Line 1 is the title; line 2 is the type's display name and, when the entity has one, its state. A type the profile does not list shows the generic icon and the raw type name. */
export function entityLook(node: GraphNode, profile: SourceProfile | undefined): EntityLook {
  const type = profile?.entityTypes.find((entry) => entry.type === node.ref.entityType);
  const typeName = type?.label ?? node.ref.entityType;
  const state = stateOf(node, type?.stateProperty ?? null);
  return { iconKey: type?.icon ?? 'generic', line1: node.display.title, line2: state === undefined ? typeName : `${typeName} · ${state}` };
}
