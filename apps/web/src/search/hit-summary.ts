import type { GraphNode, SourceProfile } from '@neburyx/contracts';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The values of the key properties and the state property the source profile names for the entity type, in that order, as the page shows them; a value the server masked is shown as it came. */
export function summaryOf(node: GraphNode, type: EntityTypeProfile | undefined): readonly string[] {
  if (type === undefined) return [];
  const keys = [...(type.stateProperty === null ? [] : [type.stateProperty]), ...type.keyProperties];
  const seen = new Set<string>();
  return keys.flatMap((key) => {
    if (seen.has(key)) return [];
    seen.add(key);
    const text = valueText(node.properties.find((property) => property.key === key)?.value);
    return text === undefined ? [] : [text];
  });
}
