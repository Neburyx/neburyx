import { z } from 'zod';
import { OPERATIONS } from '../../sources/operations.js';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';

export const CAPABILITIES_ID = 'capabilities';

const SUPPORTED_PRODUCT = 'Neo4j Kernel';
const SUPPORTED_VERSIONS: readonly RegExp[] = [/^5\.26\.\d+$/, /^2026\.\d+\.\d+$/];

const operationSchema = z.strictObject({ name: z.string().min(1), status: z.enum(['supported', 'by-template', 'unsupported']) });

export const capabilitiesItemSchema = z.strictObject({
  product: z.string().min(1),
  version: z.string(),
  edition: z.string().min(1),
  versionSupported: z.boolean(),
  operations: z.array(operationSchema),
});

export type CapabilitiesItem = z.infer<typeof capabilitiesItemSchema>;

const rowSchema = z.object({ name: z.string().min(1), version: z.string(), edition: z.string().min(1) });

/** True for the server product and versions the product supports: 5.26 LTS and the 2026 line. */
export function isSupportedServer(product: string, version: string): boolean {
  return product === SUPPORTED_PRODUCT && SUPPORTED_VERSIONS.some((pattern) => pattern.test(version));
}

function operationsOf(supported: boolean): CapabilitiesItem['operations'] {
  if (!supported) return [];
  return Object.entries(OPERATIONS).map(([name, status]) => ({ name, status }));
}

function normalize(rows: readonly Row[]): readonly Item[] {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw new Error('the capabilities read must return exactly one row');
  const server = rowSchema.parse(row);
  const versionSupported = isSupportedServer(server.name, server.version);
  const item: CapabilitiesItem = { product: server.name, version: server.version, edition: server.edition, versionSupported, operations: operationsOf(versionSupported) };
  return [item];
}

export const capabilitiesTemplate: TemplateDefinition = {
  id: CAPABILITIES_ID,
  version: '1',
  auditAction: 'source.capabilities',
  cypher: "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition",
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: false,
  entityParams: [],
  relationshipParams: [],
  refsOf: () => [],
  normalize,
};
