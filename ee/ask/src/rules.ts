import { AI_ALL_PROPERTIES, type AiMappingView, type AiSettings, type ConfigureWarning } from '@neburyx/contracts';

export type TypeKind = 'entity' | 'relationship';

/** What may be sent to a model, decided once at start-up from the operator's list and the mapping. */
export interface PropertyRules {
  readonly piiOverride: boolean;
  readonly isSendable: (kind: TypeKind, type: string, name: string) => boolean;
  readonly isPii: (kind: TypeKind, type: string, name: string) => boolean;
}

export type RulesResult = { readonly problems: readonly string[]; readonly warnings: readonly ConfigureWarning[]; readonly rules?: PropertyRules };

export const PII_OVERRIDE_EVENT = 'ai.pii_override';

const keyOf = (kind: TypeKind, type: string): string => `${kind}:${type}`;

export function noPropertyRules(): PropertyRules {
  return { piiOverride: false, isSendable: () => false, isPii: () => false };
}

function rulesOf(allowed: ReadonlyMap<string, ReadonlySet<string>>, pii: ReadonlyMap<string, ReadonlySet<string>>, piiOverride: boolean): PropertyRules {
  return {
    piiOverride,
    isSendable: (kind, type, name) => allowed.get(keyOf(kind, type))?.has(name) === true,
    isPii: (kind, type, name) => pii.get(keyOf(kind, type))?.has(name) === true,
  };
}

/** The list narrows what the gate left; a `pii` property is sent only when the override is on and the property is named, never through the wildcard. */
export function buildPropertyRules(settings: AiSettings, view: AiMappingView | undefined): RulesResult {
  const lists = Object.entries(settings.properties ?? {});
  const override = settings.pii_override === true;
  const problems: string[] = [];
  const warnings: ConfigureWarning[] = [];
  const allowed = new Map<string, Set<string>>();
  const pii = new Map<string, Set<string>>();

  if (lists.length > 0 && view === undefined) {
    return { problems: ['ai.properties cannot be checked: the mapping view is missing'], warnings };
  }
  for (const type of view?.types ?? []) pii.set(keyOf(type.kind, type.name), new Set(type.properties.filter((property) => property.pii).map((property) => property.name)));

  let namedPii = 0;
  for (const [typeName, names] of lists) {
    const matches = (view?.types ?? []).filter((type) => type.name === typeName);
    const [type, ...others] = matches;
    if (type === undefined) {
      problems.push(`ai.properties: ${typeName} is not an entity type or a relationship type of the mapping`);
      continue;
    }
    if (others.length > 0) {
      problems.push(`ai.properties: ${typeName} is both an entity type and a relationship type of the mapping, so it cannot be listed`);
      continue;
    }
    const key = keyOf(type.kind, type.name);
    const sendable = new Set<string>();
    allowed.set(key, sendable);
    for (const name of names) {
      if (name === AI_ALL_PROPERTIES) {
        for (const property of type.properties) if (!property.pii) sendable.add(property.name);
        continue;
      }
      const property = type.properties.find((candidate) => candidate.name === name);
      if (property === undefined) problems.push(`ai.properties.${typeName}: ${name} is not a property the mapping names for it`);
      else if (!property.pii) sendable.add(name);
      else if (!override) problems.push(`ai.properties.${typeName}: ${name} is a pii property; naming it needs ai.pii_override: true`);
      else {
        sendable.add(name);
        namedPii += 1;
        warnings.push({ event: PII_OVERRIDE_EVENT, message: `ai.properties.${typeName}: ${name} is a pii property and ai.pii_override is on, so it may be sent to the model` });
      }
    }
  }
  if (override && namedPii === 0 && problems.length === 0) {
    warnings.push({ event: PII_OVERRIDE_EVENT, message: 'ai.pii_override is on but no pii property is named in ai.properties' });
  }
  return problems.length > 0 ? { problems, warnings } : { problems, warnings, rules: rulesOf(allowed, pii, override) };
}
