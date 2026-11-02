import { z } from 'zod';
import type { Item, Row } from '../types.js';
import type { TemplateDefinition } from '../catalog.js';

export const CONNECTIVITY_ID = 'connectivity';

export const connectivityTemplate: TemplateDefinition = {
  id: CONNECTIVITY_ID,
  version: '1',
  auditAction: 'source.connectivity',
  cypher: "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition",
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  refsOf: () => [],
  normalize: (rows: readonly Row[]): readonly Item[] => rows.map((row) => ({ product: String(row['name']), version: String(row['version']), edition: String(row['edition']) })),
};
