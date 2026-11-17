import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { unreadableOf } from './unreadable.js';

export const SCHEMA_DRAFT_TOKENS_ID = 'schema-draft-tokens';
export const SCHEMA_DRAFT_INDEXES_ID = 'schema-draft-indexes';
export const SCHEMA_DRAFT_CONSTRAINTS_ID = 'schema-draft-constraints';

/** The most names, indexes or constraints of one kind a draft reads: the template reads at most one more than this, so a list longer than the bound is known to be cut and is never read whole. */
export const SCHEMA_DRAFT_CAP = 500;
const PROBE = SCHEMA_DRAFT_CAP + 1;

const names = z.array(z.string().min(1));

/** The names the database holds, each list cut at the bound with a flag; no property value is read, only the token lists. */
export const schemaDraftTokensItemSchema = z.strictObject({
  labels: names,
  labelsCut: z.boolean(),
  types: names,
  typesCut: z.boolean(),
  propertyKeys: names,
  propertyKeysCut: z.boolean(),
});

const entityKindSchema = z.enum(['NODE', 'RELATIONSHIP']);

const schemaObjectSchema = z.strictObject({
  name: z.string(),
  type: z.string(),
  entityType: entityKindSchema,
  labelsOrTypes: names,
  properties: names,
});

const schemaDraftIndexSchema = schemaObjectSchema.extend({ state: z.string() });
const schemaDraftConstraintSchema = schemaObjectSchema;
export type SchemaDraftIndex = z.infer<typeof schemaDraftIndexSchema>;
export type SchemaDraftConstraint = z.infer<typeof schemaDraftConstraintSchema>;

export const schemaDraftIndexesItemSchema = z.strictObject({ indexes: z.array(schemaDraftIndexSchema), truncated: z.boolean() });
export const schemaDraftConstraintsItemSchema = z.strictObject({ constraints: z.array(schemaDraftConstraintSchema), truncated: z.boolean() });

function oneRow<T>(schema: z.ZodType<T>): (rows: readonly Row[]) => readonly Item[] {
  return (rows) => {
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) return [{ unreadable: { rows: String(rows.length) } }];
    const parsed = schema.safeParse(row);
    return [parsed.success ? (parsed.data as Item) : unreadableOf(row)];
  };
}

const sharedFields = {
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: false,
  rows: 'one',
  entityParams: [],
  relationshipParams: [],
  gateParameters: [],
  refsOf: () => [],
} as const;

/** Always one row, also on an empty database: each list comes from a subquery, and an aggregation without a grouping key yields a row of its own. */
export const schemaDraftTokensTemplate: TemplateDefinition = {
  ...sharedFields,
  id: SCHEMA_DRAFT_TOKENS_ID,
  version: '1',
  auditAction: 'source.schema_draft_tokens',
  cypher:
    'CALL { CALL db.labels() YIELD label WITH label ORDER BY label LIMIT ' + PROBE + ` RETURN collect(label)[..${SCHEMA_DRAFT_CAP}] AS labels, count(*) > ${SCHEMA_DRAFT_CAP} AS labelsCut } ` +
    'CALL { CALL db.relationshipTypes() YIELD relationshipType WITH relationshipType ORDER BY relationshipType LIMIT ' + PROBE + ` RETURN collect(relationshipType)[..${SCHEMA_DRAFT_CAP}] AS types, count(*) > ${SCHEMA_DRAFT_CAP} AS typesCut } ` +
    'CALL { CALL db.propertyKeys() YIELD propertyKey WITH propertyKey ORDER BY propertyKey LIMIT ' + PROBE + ` RETURN collect(propertyKey)[..${SCHEMA_DRAFT_CAP}] AS propertyKeys, count(*) > ${SCHEMA_DRAFT_CAP} AS propertyKeysCut } ` +
    'RETURN labels, labelsCut, types, typesCut, propertyKeys, propertyKeysCut',
  normalize: oneRow(schemaDraftTokensItemSchema),
};

/** Every index the server lists, with the state of each; a lookup index has no label or property list, which then reads as empty. */
export const schemaDraftIndexesTemplate: TemplateDefinition = {
  ...sharedFields,
  id: SCHEMA_DRAFT_INDEXES_ID,
  version: '1',
  auditAction: 'source.schema_draft_indexes',
  cypher:
    'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state ' +
    `ORDER BY name LIMIT ${PROBE} ` +
    'RETURN collect({name: name, type: type, entityType: entityType, labelsOrTypes: coalesce(labelsOrTypes, []), properties: coalesce(properties, []), state: state})' +
    `[..${SCHEMA_DRAFT_CAP}] AS indexes, count(*) > ${SCHEMA_DRAFT_CAP} AS truncated`,
  normalize: oneRow(schemaDraftIndexesItemSchema),
};

/** Every constraint the server lists. */
export const schemaDraftConstraintsTemplate: TemplateDefinition = {
  ...sharedFields,
  id: SCHEMA_DRAFT_CONSTRAINTS_ID,
  version: '1',
  auditAction: 'source.schema_draft_constraints',
  cypher:
    'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties ' +
    `ORDER BY name LIMIT ${PROBE} ` +
    'RETURN collect({name: name, type: type, entityType: entityType, labelsOrTypes: coalesce(labelsOrTypes, []), properties: coalesce(properties, [])})' +
    `[..${SCHEMA_DRAFT_CAP}] AS constraints, count(*) > ${SCHEMA_DRAFT_CAP} AS truncated`,
  normalize: oneRow(schemaDraftConstraintsItemSchema),
};
