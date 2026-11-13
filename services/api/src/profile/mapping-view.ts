import type { AiMappingView, AiViewEnds, AiViewProperty, AiViewRule, AiViewType } from '@neburyx/contracts';
import { entityProjection, relationshipProjection } from '../mapping/projection.js';
import type { MappingModel } from '../mapping/model.js';

interface Collected {
  readonly name: string;
  readonly kind: AiViewType['kind'];
  readonly properties: Map<string, boolean>;
  readonly ends: Map<string, AiViewEnds>;
}

function collect(types: Map<string, Collected>, name: string, kind: AiViewType['kind'], properties: readonly string[], pii: ReadonlySet<string>, ends?: AiViewEnds): void {
  const key = `${kind}:${name}`;
  const known = types.get(key) ?? { name, kind, properties: new Map<string, boolean>(), ends: new Map<string, AiViewEnds>() };
  types.set(key, known);
  if (ends !== undefined) {
    const pair = JSON.stringify([ends.from, ends.to]);
    const seen = known.ends.get(pair);
    known.ends.set(pair, { ...ends, timed: ends.timed || seen?.timed === true });
  }
  for (const property of properties) known.properties.set(property, (known.properties.get(property) ?? false) || pii.has(property));
}

/** What an operator's property list may name: the properties the mapping names for each type, as the gate projects a record to them, joined across sources and rows. */
export function aiMappingViewOf(mapping: MappingModel): AiMappingView {
  const types = new Map<string, Collected>();
  for (const source of mapping.sources) {
    for (const entity of source.entities) collect(types, entity.type, 'entity', entityProjection(entity), new Set(entity.pii));
    for (const relationship of source.relationships) collect(types, relationship.type, 'relationship', relationshipProjection(relationship), new Set(), { from: relationship.from, to: relationship.to, timed: relationship.observedAt !== undefined });
  }
  const rules = new Map<string, AiViewRule>();
  for (const source of mapping.sources) for (const rule of source.derived) rules.set(rule.id, { id: rule.id, from: rule.from, to: rule.to });
  return {
    types: [...types.values()].map((type) => ({
      name: type.name,
      kind: type.kind,
      properties: [...type.properties].map(([name, pii]): AiViewProperty => ({ name, pii })),
      ...(type.kind === 'relationship' ? { ends: [...type.ends.values()] } : {}),
    })),
    ...(rules.size === 0 ? {} : { derivedRules: [...rules.values()] }),
  };
}
