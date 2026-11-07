import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { unreadableOf } from './unreadable.js';

export const SCHEMA_INDEXES_ID = 'schema-indexes';

/** The most indexes one read returns; more than this many matching the mapped names is an answer the check does not judge. */
export const INDEX_CAP = 500;

export const indexEntrySchema = z.strictObject({
  type: z.enum(['RANGE', 'TEXT']),
  entityType: z.enum(['NODE', 'RELATIONSHIP']),
  name: z.string().min(1),
  property: z.string().min(1),
  single: z.boolean(),
  state: z.string(),
  constrained: z.boolean(),
});

export type IndexEntry = z.infer<typeof indexEntrySchema>;

export const schemaIndexesItemSchema = z.strictObject({ indexes: z.array(indexEntrySchema), truncated: z.boolean() });

export type SchemaIndexesItem = z.infer<typeof schemaIndexesItemSchema>;

function normalize(rows: readonly Row[]): readonly Item[] {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) return [{ unreadable: { rows: String(rows.length) } }];
  const parsed = schemaIndexesItemSchema.safeParse(row);
  return [parsed.success ? parsed.data : unreadableOf(row)];
}

/**
 * The RANGE and TEXT indexes whose label or type, and whose first property, the mapping names, with the state of each and whether a constraint backs it.
 * FULLTEXT indexes are not read: they never cover a mapped property, and a multi-label one could carry a label the mapping does not name.
 */
export const schemaIndexesTemplate: TemplateDefinition = {
  id: SCHEMA_INDEXES_ID,
  version: '1',
  auditAction: 'source.schema_indexes',
  cypher:
    'SHOW INDEXES YIELD type, entityType, labelsOrTypes, properties, state, owningConstraint ' +
    "WHERE type IN ['RANGE', 'TEXT'] AND labelsOrTypes[0] IN ($mappedLabels + $mappedTypes) AND properties[0] IN $mappedProperties " +
    'RETURN collect({type: type, entityType: entityType, name: labelsOrTypes[0], property: properties[0], single: size(properties) = 1, state: state, constrained: owningConstraint IS NOT NULL})' +
    `[..${INDEX_CAP}] AS indexes, count(*) > ${INDEX_CAP} AS truncated`,
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: false,
  rows: 'one',
  entityParams: [],
  relationshipParams: [],
  gateParameters: ['mappedLabels', 'mappedTypes', 'mappedProperties'],
  refsOf: () => [],
  normalize,
};
