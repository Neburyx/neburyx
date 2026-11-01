import { Document, isMap, isSeq } from 'yaml';
import { defaultKeyProperties } from '../mapping/build.js';
import type { EntityModel, SourceModel } from '../mapping/model.js';
import { canonicalBind, sortedEntries } from './canonical.js';

const DEFAULT_ICON = 'generic';

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonEmpty(key: string, values: readonly string[]): Record<string, readonly string[]> {
  return values.length === 0 ? {} : { [key]: values };
}

function displayOf(entity: EntityModel): Record<string, unknown> {
  const defaults = defaultKeyProperties(entity.stableId, entity.search, entity.filterable, entity.pii);
  return {
    ...(entity.display.icon === DEFAULT_ICON ? {} : { icon: entity.display.icon }),
    ...(sameList(entity.display.keyProperties, defaults) ? {} : { key_properties: entity.display.keyProperties }),
    ...(entity.display.stateProperty === undefined ? {} : { state_property: entity.display.stateProperty }),
  };
}

function entityOf(entity: EntityModel): Record<string, unknown> {
  const display = displayOf(entity);
  return {
    type: entity.type,
    label: entity.label,
    stable_id: entity.stableId,
    ...(entity.title === `{${entity.stableId}}` ? {} : { title: entity.title }),
    ...nonEmpty('search', entity.search),
    ...nonEmpty('reference', entity.reference),
    ...nonEmpty('pii', entity.pii),
    ...nonEmpty('filterable', entity.filterable),
    ...(Object.keys(display).length === 0 ? {} : { display }),
  };
}

function presetOf(preset: SourceModel['presets'][number]): Record<string, unknown> {
  const labels = sortedEntries(preset.labels);
  return {
    id: preset.id,
    name: preset.name,
    template: preset.template,
    bind: canonicalBind(preset.bind),
    ...(labels.length === 0 ? {} : { labels: Object.fromEntries(labels) }),
  };
}

/** Leaves out every value the mapping loader fills in by default and writes each item in flow style. */
export function mappingExcerptOf(source: SourceModel): string {
  const document = {
    entities: source.entities.map(entityOf),
    relationships: source.relationships.map((relationship) => ({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      ...(relationship.stableId === undefined ? {} : { stable_id: relationship.stableId }),
      ...(relationship.observedAt === undefined ? {} : { observed_at: relationship.observedAt }),
      ...nonEmpty('evidence', relationship.evidence),
      ...nonEmpty('filterable', relationship.filterable),
    })),
    derived: source.derived.map((rule) => ({
      id: rule.id,
      from: rule.from,
      to: rule.to,
      via: rule.via,
      rule_version: rule.ruleVersion,
      ...(rule.stopListProperty === undefined ? {} : { stop_list_property: rule.stopListProperty }),
    })),
    patterns: source.presets.map(presetOf),
  };
  const written = new Document(document, { aliasDuplicateObjects: false });
  for (const section of written.contents && isMap(written.contents) ? written.contents.items : []) {
    if (isSeq(section.value)) for (const item of section.value.items) if (isMap(item)) item.flow = true;
  }
  return written.toString({ blockQuote: false, lineWidth: 0, flowCollectionPadding: false });
}
