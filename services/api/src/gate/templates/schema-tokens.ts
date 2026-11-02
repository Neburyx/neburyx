import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { unreadableOf } from './unreadable.js';

export const SCHEMA_TOKENS_ID = 'schema-tokens';

/** The mapped labels and relationship types that exist on the source: a label or type is listed while a node or relationship carries it. */
export const schemaTokensItemSchema = z.strictObject({ labels: z.array(z.string()), types: z.array(z.string()) });

export type SchemaTokensItem = z.infer<typeof schemaTokensItemSchema>;

function normalize(rows: readonly Row[]): readonly Item[] {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) return [{ unreadable: { rows: String(rows.length) } }];
  const parsed = schemaTokensItemSchema.safeParse(row);
  return [parsed.success ? parsed.data : unreadableOf(row)];
}

/** Always one row, also on an empty database: each list comes from a subquery, and an aggregation without a grouping key yields a row of its own. */
export const schemaTokensTemplate: TemplateDefinition = {
  id: SCHEMA_TOKENS_ID,
  version: '1',
  auditAction: 'source.schema_tokens',
  cypher:
    'CALL { CALL db.labels() YIELD label RETURN collect(label) AS labels } ' +
    'CALL { CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types } ' +
    'RETURN [l IN $mappedLabels WHERE l IN labels] AS labels, [t IN $mappedTypes WHERE t IN types] AS types',
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  gateParameters: ['mappedLabels', 'mappedTypes'],
  refsOf: () => [],
  normalize,
};
