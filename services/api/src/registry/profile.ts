import type { FilterKind, SourceProfile } from '@neburyx/contracts';
import { isKeyed, type SourceModel } from '../mapping/model.js';
import { entityProjection, relationshipProjection } from '../mapping/projection.js';
import { canonicalBind, sortedEntries } from './canonical.js';
import { mappingExcerptOf } from './excerpt.js';

/** The presets of a source as a client reads them, in the mapping's order. */
export function presetProfilesOf(source: SourceModel): SourceProfile['presets'] {
  return source.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    template: preset.template,
    bind: canonicalBind(preset.bind),
    labels: sortedEntries(preset.labels).map(([key, text]) => ({ key, text })),
  }));
}

/** The kind of each filterable property as the mapping declares it, `unknown` where it does not; the row's time property is listed when the mapping declares its kind. Nothing is read from the source. */
function filterKindsOf(filterable: readonly string[], kinds: Readonly<Record<string, FilterKind>> | undefined): Record<string, FilterKind | 'unknown'> {
  const declared = kinds ?? {};
  const names = [...filterable, ...Object.keys(declared).filter((property) => !filterable.includes(property))];
  return Object.fromEntries(names.map((property) => [property, Object.hasOwn(declared, property) ? (declared[property] ?? 'unknown') : 'unknown']));
}

export function buildSourceProfile(source: SourceModel): SourceProfile {
  return {
    sourceId: source.id,
    synthetic: source.synthetic,
    vocabulary: { caseRef: source.vocabulary.caseRef ?? null },
    entityTypes: source.entities.map((entity) => ({
      type: entity.type,
      label: entity.label,
      keyed: isKeyed(entity),
      stableIdProperty: entity.stableId,
      displayName: entity.display.name ?? entity.label,
      icon: entity.display.icon,
      title: entity.title,
      titleUsesPii: entity.titleUsesPii,
      keyProperties: [...entity.display.keyProperties],
      stateProperty: entity.display.stateProperty ?? null,
      searchable: [...entity.search],
      filterable: [...entity.filterable],
      filterKinds: filterKindsOf(entity.filterable, entity.kinds),
      sortable: [...(entity.sortable ?? [])],
      pii: [...entity.pii],
      properties: entityProjection(entity),
      recordLink: entity.link === undefined ? 'none' : isKeyed(entity) ? 'unmasked' : 'always',
    })),
    relationshipTypes: source.relationships.map((relationship) => ({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      aggregate: relationship.aggregate,
      observedAt: relationship.observedAt ?? null,
      stableIdProperty: relationship.stableId ?? null,
      filterable: [...relationship.filterable],
      filterKinds: filterKindsOf(relationship.filterable, relationship.kinds),
      sortable: [...(relationship.sortable ?? [])],
      evidence: [...relationship.evidence],
      properties: relationshipProjection(relationship),
      recordLink: relationship.evidenceLink !== undefined && !relationship.aggregate,
    })),
    derivedRules: source.derived.map((rule) => ({ id: rule.id, from: rule.from, to: rule.to, via: [...rule.via], ruleVersion: rule.ruleVersion })),
    presets: presetProfilesOf(source),
    mappingExcerpt: mappingExcerptOf(source),
  };
}
