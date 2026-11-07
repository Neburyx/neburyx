import { MAPPING_CHECK_SEVERITY, UNVERIFIED_CHECKS, type MappingCheck, type MappingChecks, type MappingFinding } from '@neburyx/contracts';
import type { IndexEntry } from '../gate/templates/schema-indexes.js';
import type { EntityModel, RelationshipModel, SourceModel } from '../mapping/model.js';

/** What the schema reads found: the mapped labels and relationship types that exist, and the RANGE and TEXT indexes on the mapped names. */
export interface SchemaReads {
  readonly labels: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly indexes: readonly IndexEntry[];
}

type Fields = Pick<MappingFinding, 'entityType' | 'relationshipType' | 'from' | 'to' | 'property'>;

function finding(check: MappingCheck, fields: Fields, message: string): MappingFinding {
  return { severity: MAPPING_CHECK_SEVERITY[check], check, ...fields, message };
}

const quoted = (name: string): string => `"${name}"`;

function entityWhere(entity: EntityModel): string {
  return `Entity type ${quoted(entity.type)} (label ${quoted(entity.label)})`;
}

function relationshipWhere(relationship: RelationshipModel): string {
  return `Relationship type ${quoted(relationship.type)} from ${quoted(relationship.from)} to ${quoted(relationship.to)}`;
}

function relationshipFields(relationship: RelationshipModel): Pick<MappingFinding, 'relationshipType' | 'from' | 'to'> {
  return { relationshipType: relationship.type, from: relationship.from, to: relationship.to };
}

/** The usable state of an index: the server's own state word is never repeated. */
type IndexState = 'online' | 'building' | 'failed';

function stateOf(entry: IndexEntry): IndexState {
  if (entry.state === 'ONLINE') return 'online';
  return entry.state === 'POPULATING' ? 'building' : 'failed';
}

/** The single-property RANGE or TEXT indexes on one label or relationship type and one property; a composite index does not serve its first property. */
function indexesOn(reads: SchemaReads, kind: IndexEntry['entityType'], name: string, property: string): IndexEntry[] {
  return reads.indexes.filter((entry) => entry.entityType === kind && entry.name === name && entry.property === property && entry.single);
}

function judgeIndex(reads: SchemaReads, kind: IndexEntry['entityType'], name: string, property: string, missing: MappingCheck, fields: Fields, where: string, what: string): MappingFinding[] {
  const found = indexesOn(reads, kind, name, property);
  if (found.some((entry) => stateOf(entry) === 'online')) return [];
  if (found.some((entry) => stateOf(entry) === 'building')) {
    return [finding('index-building', { ...fields, property }, `${where}: the index on the ${what} property ${quoted(property)} is still being built`)];
  }
  if (found.length > 0) return [finding('index-failed', { ...fields, property }, `${where}: the index on the ${what} property ${quoted(property)} cannot be used`)];
  return [finding(missing, { ...fields, property }, `${where}: no index on the ${what} property ${quoted(property)}`)];
}

/** The findings for labels and relationship types that the mapping names and the source does not have. */
export function judgeTokens(source: SourceModel, reads: Pick<SchemaReads, 'labels' | 'types'>): MappingFinding[] {
  const found: MappingFinding[] = [];
  for (const entity of source.entities) {
    if (!reads.labels.has(entity.label)) found.push(finding('label', { entityType: entity.type }, `${entityWhere(entity)}: no node carries the label`));
  }
  for (const relationship of source.relationships) {
    if (!reads.types.has(relationship.type)) found.push(finding('relationship-type', relationshipFields(relationship), `${relationshipWhere(relationship)}: no relationship of the type exists`));
  }
  return found;
}

/**
 * What to do about an entity type's `stable_id`: nothing (a constraint makes it unique), scan it for duplicates (a RANGE index that is online and no constraint),
 * wait (the RANGE index is still being built), or fail it (the RANGE index cannot be used, or there is none). The scan reads only an online index: with any other
 * state the hint cannot be honoured and the planner would scan the label and hold every value.
 */
export type StableIdAction = 'unique' | 'scan' | 'building' | 'failed' | 'unindexed';

export function stableIdActionOf(entity: EntityModel, reads: SchemaReads): StableIdAction {
  const found = indexesOn(reads, 'NODE', entity.label, entity.stableId);
  if (found.some((entry) => entry.constrained)) return 'unique';
  const range = found.filter((entry) => entry.type === 'RANGE');
  if (range.some((entry) => stateOf(entry) === 'online')) return 'scan';
  if (range.some((entry) => stateOf(entry) === 'building')) return 'building';
  return range.length > 0 ? 'failed' : 'unindexed';
}

/** The entity types of the source whose label exists and whose `stable_id` needs the duplicate scan. */
export function entitiesToScan(source: SourceModel, reads: SchemaReads): EntityModel[] {
  return source.entities.filter((entity) => reads.labels.has(entity.label) && stableIdActionOf(entity, reads) === 'scan');
}

/** The findings that the index read decides: the indexes on search, reference, evidence and sort properties, and the relationship and entity `stable_id` indexes. */
export function judgeIndexes(source: SourceModel, reads: SchemaReads): MappingFinding[] {
  const found: MappingFinding[] = [];
  for (const entity of source.entities) {
    if (!reads.labels.has(entity.label)) continue;
    const fields: Fields = { entityType: entity.type };
    for (const property of entity.search) found.push(...judgeIndex(reads, 'NODE', entity.label, property, 'search-index', fields, entityWhere(entity), 'search'));
    for (const property of entity.reference) found.push(...judgeIndex(reads, 'NODE', entity.label, property, 'reference-index', fields, entityWhere(entity), 'reference'));
    const stable = stableIdActionOf(entity, reads);
    if (stable === 'unindexed') {
      found.push(
        finding('stable-id-unindexed', { ...fields, property: entity.stableId }, `${entityWhere(entity)}: the stable id property ${quoted(entity.stableId)} needs a uniqueness constraint or a RANGE index`),
      );
    } else if (stable === 'building') {
      found.push(finding('index-building', { ...fields, property: entity.stableId }, `${entityWhere(entity)}: the index on the stable id property ${quoted(entity.stableId)} is still being built`));
    } else if (stable === 'failed') {
      found.push(finding('index-failed', { ...fields, property: entity.stableId }, `${entityWhere(entity)}: the index on the stable id property ${quoted(entity.stableId)} cannot be used`));
    }
  }
  for (const relationship of source.relationships) {
    if (!reads.types.has(relationship.type)) continue;
    const fields: Fields = relationshipFields(relationship);
    const where = relationshipWhere(relationship);
    for (const property of relationship.evidence) found.push(...judgeIndex(reads, 'RELATIONSHIP', relationship.type, property, 'evidence-index', fields, where, 'evidence'));
    if (relationship.observedAt !== undefined) found.push(...judgeIndex(reads, 'RELATIONSHIP', relationship.type, relationship.observedAt, 'sort-index', fields, where, 'sort'));
    if (relationship.stableId !== undefined && indexesOn(reads, 'RELATIONSHIP', relationship.type, relationship.stableId).length === 0) {
      found.push(finding('rel-stable-id-unindexed', { ...fields, property: relationship.stableId }, `${where}: no index on the stable id property ${quoted(relationship.stableId)}`));
    } else if (relationship.stableId !== undefined && !indexesOn(reads, 'RELATIONSHIP', relationship.type, relationship.stableId).some((entry) => entry.constrained)) {
      found.push(
        finding('rel-stable-id-unconstrained', { ...fields, property: relationship.stableId }, `${where}: advice: a uniqueness constraint on the stable id property ${quoted(relationship.stableId)} is needed for paging without a repeat or a gap`),
      );
    }
  }
  return found;
}

/** The result of scanning one entity type's `stable_id` for duplicates: how many values occur on more than one node, or that the scan could not be finished. */
export type ScanResult = { readonly duplicated: number } | 'unverified';

export function judgeScan(entity: EntityModel, result: ScanResult): MappingFinding[] {
  const fields: Fields = { entityType: entity.type, property: entity.stableId };
  if (result === 'unverified') return [finding('stable-id-unverified', fields, `${entityWhere(entity)}: the stable id property ${quoted(entity.stableId)} could not be checked for duplicates in time`)];
  if (result.duplicated > 0) {
    const noun = result.duplicated === 1 ? 'value occurs' : 'values occur';
    return [finding('stable-id-unique', fields, `${entityWhere(entity)}: ${result.duplicated} ${noun} more than once in the stable id property ${quoted(entity.stableId)}`)];
  }
  return [finding('stable-id-unenforced', fields, `${entityWhere(entity)}: no constraint enforces that the stable id property ${quoted(entity.stableId)} is unique; no duplicate was found`)];
}

/** The strongest of the findings: fail, then not-verified, then warn, then pass. */
export function statusOf(findings: readonly MappingFinding[]): MappingChecks['status'] {
  if (findings.some((entry) => entry.severity === 'fail')) return 'fail';
  if (findings.some((entry) => UNVERIFIED_CHECKS.includes(entry.check))) return 'not-verified';
  return findings.some((entry) => entry.severity === 'warn') ? 'warn' : 'pass';
}

export function checksOf(findings: readonly MappingFinding[]): MappingChecks {
  return { status: statusOf(findings), findings: [...findings] };
}

export const NOT_RUN: MappingChecks = { status: 'not-run', findings: [] };

const READ_LABELS: Readonly<Record<'tokens' | 'indexes' | 'scan', string>> = {
  tokens: 'labels and relationship types',
  indexes: 'indexes',
  scan: 'stable ids',
};

/** The finding for a schema read the server refused: the login may not run it. */
export function refusedFinding(read: 'tokens' | 'indexes' | 'scan'): MappingFinding {
  const messages = {
    indexes: 'The index checks were not verified because the login may not list indexes (grant SHOW INDEX and SHOW CONSTRAINT); a search on this source may scan.',
    tokens: 'The label and relationship type checks were not verified because the login may not list them.',
    scan: 'The stable id checks were not verified because the login may not read the nodes.',
  };
  const message = messages[read];
  return finding('schema-refused', {}, message);
}

/** The finding for a schema read whose answer the check could not read. */
export function unreadableFinding(read: 'tokens' | 'indexes' | 'scan'): MappingFinding {
  return finding('schema-unreadable', {}, `The answer of the source about its ${READ_LABELS[read]} could not be read, so that part of the mapping was not verified.`);
}
