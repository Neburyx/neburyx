import type { SourceProfile } from '@neburyx/contracts';
import type { SourceModel } from '../mapping/model.js';
import { canonicalBind, sortedEntries } from './canonical.js';
import { mappingExcerptOf } from './excerpt.js';

export function buildSourceProfile(source: SourceModel): SourceProfile {
  return {
    sourceId: source.id,
    synthetic: source.synthetic,
    vocabulary: { caseRef: source.vocabulary.caseRef ?? null },
    entityTypes: source.entities.map((entity) => ({
      type: entity.type,
      label: entity.label,
      icon: entity.display.icon,
      title: entity.title,
      titleUsesPii: entity.titleUsesPii,
      keyProperties: [...entity.display.keyProperties],
      stateProperty: entity.display.stateProperty ?? null,
      searchable: [...entity.search],
      filterable: [...entity.filterable],
      pii: [...entity.pii],
    })),
    relationshipTypes: source.relationships.map((relationship) => ({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      aggregate: relationship.aggregate,
      observedAt: relationship.observedAt ?? null,
      filterable: [...relationship.filterable],
      evidence: [...relationship.evidence],
    })),
    derivedRules: source.derived.map((rule) => ({ id: rule.id, from: rule.from, to: rule.to, via: [...rule.via], ruleVersion: rule.ruleVersion })),
    presets: source.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      template: preset.template,
      bind: canonicalBind(preset.bind),
      labels: sortedEntries(preset.labels).map(([key, text]) => ({ key, text })),
    })),
    mappingExcerpt: mappingExcerptOf(source),
  };
}
