import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { unreadableOf } from './unreadable.js';

export const PRIVILEGES_ID = 'privileges';

/** One row of the login's privileges, in the columns the inspection asks for. */
export const privilegeRowSchema = z.strictObject({
  access: z.string(),
  action: z.string(),
  resource: z.string(),
  graph: z.string(),
  segment: z.string(),
});

export type PrivilegeRow = z.infer<typeof privilegeRowSchema>;

function normalize(rows: readonly Row[]): readonly Item[] {
  return rows.map((row): Item => {
    const parsed = privilegeRowSchema.safeParse(row);
    return parsed.success ? parsed.data : unreadableOf(row);
  });
}

/**
 * Everything the login holds except the plain read rights and the rights every login has by default (the PUBLIC role: execute, load; the roles from reader upward add the index and constraint listings),
 * so that an action name a newer server adds comes back instead of being filtered away.
 */
export const privilegesTemplate: TemplateDefinition = {
  id: PRIVILEGES_ID,
  version: '1',
  auditAction: 'source.privileges',
  cypher:
    "SHOW USER PRIVILEGES YIELD access, action, resource, graph, segment WHERE NOT action IN ['access', 'traverse', 'read', 'match', 'execute', 'execute_function', 'load', 'show_index', 'show_constraint'] " +
    'RETURN DISTINCT access, action, resource, graph, segment LIMIT $limit + 1',
  paramsSchema: z.strictObject({}),
  scope: 'system',
  paged: true,
  entityParams: [],
  relationshipParams: [],
  refsOf: () => [],
  normalize,
};
