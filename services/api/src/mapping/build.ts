import type { PresetTemplate } from '@neburyx/contracts';
import { resolveBudgets } from './budgets.js';
import { hashSource } from './hash.js';
import { checkLink } from './links.js';
import {
  MAX_EVIDENCE_PROPERTIES,
  MAX_FACET_PROBES,
  MAX_REFERENCE_PROPERTIES,
  MAX_SEARCH_PROPERTIES,
  type DerivedRuleModel,
  type EntityModel,
  type MappingModel,
  type PresetModel,
  type RelationshipModel,
  type SourceModel,
} from './model.js';
import type { RawDerivedRule, RawEntity, RawMappingFile, RawPreset, RawRelationship, RawSource } from './schema.js';

export interface BuildIssue {
  readonly segments: readonly (string | number)[];
  readonly reason: string;
}

type Report = (segments: readonly (string | number)[], reason: string) => void;

const MAX_DEFAULT_KEY_PROPERTIES = 3;
const MIN_VIA_LENGTH = 3;
const TITLE_PLACEHOLDER = /\{([^{}]*)\}/g;

const PRESET_BINDINGS: Readonly<Record<PresetTemplate, readonly { readonly key: string; readonly mapped: 'entity' | 'relationship' }[]>> = {
  'shared-attribute': [
    { key: 'anchor', mapped: 'entity' },
    { key: 'attribute', mapped: 'entity' },
    { key: 'via', mapped: 'relationship' },
  ],
  'linked-entities': [
    { key: 'anchor', mapped: 'entity' },
    { key: 'target', mapped: 'entity' },
    { key: 'via', mapped: 'relationship' },
  ],
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function defaultKeyProperties(
  stableId: string,
  search: readonly string[],
  filterable: readonly string[],
  pii: readonly string[],
): string[] {
  return unique([stableId, ...search, ...filterable])
    .filter((property) => !pii.includes(property))
    .slice(0, MAX_DEFAULT_KEY_PROPERTIES);
}

function parseTitle(title: string): { readonly properties: string[] } | { readonly problem: string } {
  const properties: string[] = [];
  for (const match of title.matchAll(TITLE_PLACEHOLDER)) {
    const property = match[1] ?? '';
    if (property === '') return { problem: 'has an empty placeholder' };
    properties.push(property);
  }
  if (/[{}]/.test(title.replace(TITLE_PLACEHOLDER, ''))) return { problem: 'has an unbalanced or nested placeholder' };
  return { properties: unique(properties) };
}

function buildEntity(raw: RawEntity, path: readonly (string | number)[], report: Report): EntityModel {
  const search = raw.search ?? [];
  search.forEach((property, index) => {
    if (search.indexOf(property) !== index) report([...path, 'search', index], `lists ${property} more than once`);
  });
  const reference = raw.reference ?? [];
  reference.forEach((property, index) => {
    if (reference.indexOf(property) !== index) report([...path, 'reference', index], `lists ${property} more than once`);
  });
  const piiEntries = raw.pii ?? [];
  const pii = piiEntries.map((entry) => entry.property);
  const piiClasses = Object.fromEntries(piiEntries.flatMap((entry) => (entry.class === undefined ? [] : [[entry.property, entry.class] as const])));
  const filterable = raw.filterable ?? [];
  pii.forEach((property, index) => {
    if (pii.indexOf(property) !== index) report([...path, 'pii', index], `lists ${property} more than once`);
  });

  const title = raw.title ?? `{${raw.stable_id}}`;
  const parsedTitle = raw.title === undefined ? { properties: [raw.stable_id] } : parseTitle(raw.title);
  if ('problem' in parsedTitle) report([...path, 'title'], parsedTitle.problem);
  const titleProperties = 'properties' in parsedTitle ? parsedTitle.properties : [];

  const defaultKeys = defaultKeyProperties(raw.stable_id, search, filterable, pii);
  return {
    type: raw.type,
    label: raw.label,
    stableId: raw.stable_id,
    title,
    titleProperties,
    titleUsesPii: titleProperties.some((property) => pii.includes(property)),
    search,
    reference,
    pii,
    ...(Object.keys(piiClasses).length === 0 ? {} : { piiClasses }),
    filterable,
    ...linkOf(raw, path, report),
    display: {
      ...(raw.display?.name === undefined ? {} : { name: raw.display.name }),
      icon: raw.display?.icon ?? 'generic',
      keyProperties: raw.display?.key_properties ?? defaultKeys,
      ...(raw.display?.state_property === undefined ? {} : { stateProperty: raw.display.state_property }),
    },
  };
}

function linkOf(raw: RawEntity, path: readonly (string | number)[], report: Report): { readonly link?: EntityModel['link'] } {
  if (raw.link === undefined) {
    if (raw.link_carries_value !== undefined) report([...path, 'link_carries_value'], 'is set on a type with no link');
    return {};
  }
  const pii = (raw.pii ?? []).map((entry) => entry.property);
  const keyed = pii.includes(raw.stable_id);
  const carries = raw.link_carries_value === true;
  if (raw.link_carries_value !== undefined && !keyed) report([...path, 'link_carries_value'], 'is set on a type whose stable ID is not a personal-data property');
  const check = checkLink(raw.link, {
    kind: 'entity',
    allowed: [raw.stable_id],
    allowedDescription: 'the stable ID property',
    piiProperties: keyed && carries ? pii.filter((property) => property !== raw.stable_id) : pii,
  });
  if (check.status === 'valid') return { link: keyed && carries ? { ...check.link, carriesValue: true } : check.link };
  for (const reason of check.reasons) {
    report([...path, 'link'], keyed && !carries && reason.includes('marked pii') ? `${reason}; set link_carries_value: true to put the value itself in the link, which is built only while masking is off` : reason);
  }
  return {};
}

function buildRelationship(raw: RawRelationship, path: readonly (string | number)[], entityTypes: ReadonlySet<string>, report: Report): RelationshipModel {
  for (const end of ['from', 'to'] as const) {
    if (!entityTypes.has(raw[end])) report([...path, end], `names ${raw[end]}, which is not an entity type of this source`);
  }
  const evidence = raw.evidence ?? [];
  let evidenceLink: RelationshipModel['evidenceLink'];
  if (raw.evidence_link !== undefined) {
    const check = evidence.length === 0
      ? ({ status: 'invalid', reasons: ['needs an evidence list'] } as const)
      : checkLink(raw.evidence_link, {
          kind: 'evidence',
          allowed: evidence,
          allowedDescription: 'one of the evidence properties',
          piiProperties: [],
        });
    if (check.status === 'valid') evidenceLink = check.link;
    else for (const reason of check.reasons) report([...path, 'evidence_link'], reason);
  }
  return {
    type: raw.type,
    from: raw.from,
    to: raw.to,
    ...(raw.stable_id === undefined ? {} : { stableId: raw.stable_id }),
    aggregate: raw.stable_id === undefined,
    ...(raw.observed_at === undefined ? {} : { observedAt: raw.observed_at }),
    evidence,
    filterable: raw.filterable ?? [],
    ...(evidenceLink === undefined ? {} : { evidenceLink }),
  };
}

function buildDerived(
  raw: RawDerivedRule,
  path: readonly (string | number)[],
  entityTypes: ReadonlySet<string>,
  relationshipTypes: ReadonlySet<string>,
  report: Report,
): DerivedRuleModel {
  for (const end of ['from', 'to'] as const) {
    if (!entityTypes.has(raw[end])) report([...path, end], `names ${raw[end]}, which is not an entity type of this source`);
  }
  if (raw.via.length < MIN_VIA_LENGTH || raw.via.length % 2 === 0) {
    report([...path, 'via'], 'needs an odd number of entries, at least three: relationship type, entity type, relationship type');
  }
  raw.via.forEach((entry, index) => {
    const isRelationship = index % 2 === 0;
    const known = isRelationship ? relationshipTypes.has(entry) : entityTypes.has(entry);
    if (!known) report([...path, 'via', index], `names ${entry}, which is not ${isRelationship ? 'a relationship' : 'an entity'} type of this source`);
  });
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    via: raw.via,
    ruleVersion: raw.rule_version,
    ...(raw.stop_list_property === undefined ? {} : { stopListProperty: raw.stop_list_property }),
  };
}

function buildPreset(
  raw: RawPreset,
  path: readonly (string | number)[],
  entityTypes: ReadonlySet<string>,
  relationshipTypes: ReadonlySet<string>,
  report: Report,
): PresetModel {
  const required = PRESET_BINDINGS[raw.template];
  const requiredKeys = required.map((binding) => binding.key);
  for (const binding of required) {
    const value = raw.bind[binding.key];
    if (value === undefined) {
      report([...path, 'bind'], `is missing ${binding.key}`);
      continue;
    }
    const mapped = binding.mapped === 'entity' ? entityTypes : relationshipTypes;
    if (!mapped.has(value)) report([...path, 'bind', binding.key], `names ${value}, which is not ${binding.mapped === 'entity' ? 'an entity' : 'a relationship'} type of this source`);
  }
  for (const key of Object.keys(raw.bind)) {
    if (!requiredKeys.includes(key)) report([...path, 'bind', key], `is not a binding of ${raw.template}`);
  }
  return { id: raw.id, name: raw.name, template: raw.template, bind: raw.bind, labels: raw.labels ?? Object.create(null) };
}

function reportDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => readonly string[],
  pathOf: (index: number) => readonly (string | number)[],
  noun: string,
  report: Report,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const parts = keyOf(item);
    const key = JSON.stringify(parts);
    if (seen.has(key)) report(pathOf(index), `repeats ${noun} ${parts.join(' ')}`);
    seen.add(key);
  });
}

function buildSource(raw: RawSource, index: number, report: Report): SourceModel {
  const base = ['sources', index] as const;
  const rawRelationships = raw.relationships ?? [];
  const rawDerived = raw.derived ?? [];
  const rawPresets = raw.patterns ?? [];
  const entityTypes = new Set(raw.entities.map((entity) => entity.type));
  const relationshipTypes = new Set(rawRelationships.map((relationship) => relationship.type));

  reportDuplicates(raw.entities, (entity) => [entity.type], (i) => [...base, 'entities', i, 'type'], 'entity type', report);
  reportDuplicates(rawRelationships, (r) => [r.type, 'from', r.from, 'to', r.to], (i) => [...base, 'relationships', i, 'type'], 'relationship', report);
  reportDuplicates(rawDerived, (rule) => [rule.id], (i) => [...base, 'derived', i, 'id'], 'derived rule', report);
  reportDuplicates(rawPresets, (preset) => [preset.id], (i) => [...base, 'patterns', i, 'id'], 'pattern', report);

  const searchProperties = raw.entities.reduce((total, entity) => total + new Set(entity.search ?? []).size, 0);
  if (searchProperties > MAX_SEARCH_PROPERTIES) report([...base, 'entities'], `list ${searchProperties} search properties in all, more than the ${MAX_SEARCH_PROPERTIES} a search can read`);
  const referenceProperties = raw.entities.reduce((total, entity) => total + new Set(entity.reference ?? []).size, 0);
  if (referenceProperties > MAX_REFERENCE_PROPERTIES) report([...base, 'entities'], `list ${referenceProperties} reference properties in all, more than the ${MAX_REFERENCE_PROPERTIES} a search can read`);

  const evidenceProperties = rawRelationships.reduce((total, relationship) => total + new Set(relationship.evidence ?? []).size, 0);
  if (evidenceProperties > MAX_EVIDENCE_PROPERTIES) report([...base, 'relationships'], `list ${evidenceProperties} evidence properties in all on relationships, more than the ${MAX_EVIDENCE_PROPERTIES} a search can read`);

  const searchedTypes = raw.entities.filter((entity) => (entity.search ?? []).length > 0 || (entity.reference ?? []).length > 0).length;
  const modes = (raw.entities.some((entity) => (entity.search ?? []).length > 0) ? 1 : 0) + (raw.entities.some((entity) => (entity.reference ?? []).length > 0) ? 1 : 0) + (evidenceProperties > 0 ? 1 : 0);
  const probes = searchedTypes + modes + (searchedTypes > 0 ? 1 : 0);
  if (probes > MAX_FACET_PROBES) {
    report(
      [...base, 'entities'],
      `have ${searchedTypes} entity types with a search or reference property, which needs ${probes} facet counts, more than the ${MAX_FACET_PROBES} one search can count; give search or reference properties to fewer entity types (an entity type with none is not counted)`,
    );
  }

  if (raw.demo_case !== undefined) {
    if (raw.synthetic !== true) report([...base, 'demo_case'], 'needs synthetic: true on the source');
    if (!entityTypes.has(raw.demo_case.entity.type)) report([...base, 'demo_case', 'entity', 'type'], 'is not an entity type of this source');
  }

  const budgets = resolveBudgets(raw.budgets);
  const defaultPage = raw.budgets?.default_page ?? Math.min(budgets.defaultPage, budgets.maxPage);
  if (raw.budgets?.default_page !== undefined && raw.budgets.default_page > budgets.maxPage) {
    report([...base, 'budgets', 'default_page'], `is above max_page (${budgets.maxPage})`);
  }

  const model: Omit<SourceModel, 'configHash'> = {
    id: raw.id,
    uri: raw.uri,
    database: raw.database,
    auth: { usernameEnv: raw.auth.username_env, passwordEnv: raw.auth.password_env },
    synthetic: raw.synthetic ?? false,
    ...(raw.demo_case === undefined ? {} : { demoCase: { entityType: raw.demo_case.entity.type, stableId: raw.demo_case.entity.id, caseRef: raw.demo_case.case_ref } }),
    budgets: { ...budgets, defaultPage },
    vocabulary: raw.vocabulary?.case_ref === undefined ? {} : { caseRef: raw.vocabulary.case_ref },
    entities: raw.entities.map((entity, i) => buildEntity(entity, [...base, 'entities', i], report)),
    relationships: rawRelationships.map((r, i) => buildRelationship(r, [...base, 'relationships', i], entityTypes, report)),
    derived: rawDerived.map((rule, i) => buildDerived(rule, [...base, 'derived', i], entityTypes, relationshipTypes, report)),
    presets: rawPresets.map((preset, i) => buildPreset(preset, [...base, 'patterns', i], entityTypes, relationshipTypes, report)),
    styleRules: raw.style_rules ?? [],
  };
  return { ...model, configHash: hashSource(model) };
}

export function buildMapping(raw: RawMappingFile): { readonly model: MappingModel } | { readonly issues: readonly BuildIssue[] } {
  const issues: BuildIssue[] = [];
  const report: Report = (segments, reason) => issues.push({ segments, reason });
  reportDuplicates(raw.sources, (source) => [source.id], (i) => ['sources', i, 'id'], 'source', report);
  const sources = raw.sources.map((source, index) => buildSource(source, index, report));
  return issues.length > 0 ? { issues } : { model: { sources } };
}
