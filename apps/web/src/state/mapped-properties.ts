import type { FilterKind, SourceProfile } from '@neburyx/contracts';
import type { MappedProperties, MappedPropertySets } from './presentation-state.js';

/**
 * The properties of each type as the mapping lists them. A relationship type is judged over its stored rows only (an aggregate row carries no properties): a property is listed when a stored row lists it,
 * and left out when the stored rows that list it declare different kinds, so no filter can be made on it. A row that declares none takes the kind another row declares.
 */
export function mappedPropertiesOf(profile: SourceProfile): MappedPropertySets {
  const entity: Record<string, MappedProperties> = {};
  for (const type of profile.entityTypes) entity[type.type] = { filterable: type.filterable, kinds: type.filterKinds ?? {}, pii: type.pii };
  const rows = new Map<string, SourceProfile['relationshipTypes']>();
  for (const row of profile.relationshipTypes) if (!row.aggregate) rows.set(row.type, [...(rows.get(row.type) ?? []), row]);
  const relationship: Record<string, MappedProperties> = {};
  for (const [type, stored] of rows) {
    const properties = [...new Set(stored.flatMap((row) => row.filterable))];
    const kinds: Record<string, FilterKind | 'unknown'> = {};
    const filterable: string[] = [];
    for (const property of properties) {
      const declared = new Set(stored.filter((row) => row.filterable.includes(property)).flatMap((row) => { const kind = row.filterKinds?.[property]; return kind === undefined || kind === 'unknown' ? [] : [kind]; }));
      if (declared.size > 1) continue;
      filterable.push(property);
      kinds[property] = [...declared][0] ?? 'unknown';
    }
    relationship[type] = { filterable, kinds, pii: [] };
  }
  return { entity, relationship };
}
