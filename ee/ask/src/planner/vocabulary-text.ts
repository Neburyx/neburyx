import type { AiMappingView } from '@neburyx/contracts';

/**
 * The vocabulary of the mapping as the prompt carries it: entity types, relationship types with each pair of end types and whether it carries a time, and derived rules with their end types. Names only: no property name and no value of the data.
 */
export function vocabularyText(view: AiMappingView | undefined): string {
  const types = view?.types ?? [];
  const entities = types.filter((type) => type.kind === 'entity').map((type) => type.name);
  const relationships = types
    .filter((type) => type.kind === 'relationship')
    .flatMap((type) => (type.ends ?? []).map((ends) => `${type.name}: ${ends.from} -> ${ends.to}, ${ends.timed ? 'has a time' : 'has no time'}`));
  const rules = (view?.derivedRules ?? []).map((rule) => `${rule.id}: ${rule.from} -> ${rule.to}`);
  return [`Entity types: ${entities.join(', ') || 'none'}`, `Relationship types:\n${relationships.join('\n') || 'none'}`, `Derived rules:\n${rules.join('\n') || 'none'}`].join('\n');
}
