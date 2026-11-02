import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';

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

/** What stands for a row that is not five strings: the type of each column it has, never a value, so that the check can say it could not read the listing. */
export type UnreadableRow = { readonly unreadable: Readonly<Record<string, string>> };

function normalize(rows: readonly Row[]): readonly Item[] {
  return rows.map((row): Item => {
    const parsed = privilegeRowSchema.safeParse(row);
    if (parsed.success) return parsed.data;
    const unreadable: UnreadableRow = { unreadable: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value])) };
    return unreadable;
  });
}

/**
 * Everything the login holds except the plain read rights and the rights every login has by default (the PUBLIC role: execute, load, the index and constraint listings),
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
