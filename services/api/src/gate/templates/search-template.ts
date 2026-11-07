import { searchTextSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { MAX_SEARCH_PROPERTIES } from '../../mapping/model.js';
import type { TemplateDefinition } from '../catalog.js';
import { expectedTypesOf, normalizeRows, type NormalizeContext, type Normalized } from '../normalize/index.js';
import type { CursorPosition } from '../cursor/codec.js';
import type { Item, Params, Plan, Row } from '../types.js';
import { integerCandidateOf } from './stable-id.js';

/**
 * One property of one entity type that a search matches: the type and the property both come from the mapping (`search` or `reference` lists). `value` matches the text and the integer it can be
 * (a RANGE index or a constraint serves it); `text` matches the text only (a TEXT index holds strings only).
 */
export const searchTargetSchema = z.strictObject({ entityType: z.string().min(1), property: z.string().min(1), match: z.enum(['value', 'text']) });

export type SearchTarget = z.infer<typeof searchTargetSchema>;

export const targetsSchema = z.array(searchTargetSchema).max(MAX_SEARCH_PROPERTIES);

export function targetsOf(params: Params): readonly SearchTarget[] {
  const parsed = targetsSchema.safeParse(params['targets']);
  return parsed.success ? parsed.data : [];
}

/** The column of an entity search row that names the entity types of the targets that matched its node. */
export const ENTITY_TYPES_COLUMN = 'entityTypes';

const entityTypesSchema = z.array(z.string().min(1));

/** The entity types a search row names for its node, so a node whose labels match two types is a hit of each type a target of that type matched; a row with no such column names none. */
function askedTypesOf(row: Row): readonly string[] | undefined {
  const parsed = entityTypesSchema.safeParse(row[ENTITY_TYPES_COLUMN]);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeSearch(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the search needs the normalize context');
  return [{ ...normalizeRows(context, rows, expectedTypesOf(rows, askedTypesOf)) }];
}

export const isNormalized = (item: unknown): item is Normalized => typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes) && 'unreferenced' in item && Array.isArray(item.unreferenced);

/** The hits a page of an entity search holds: its entities and the records it lists with no usable stable ID. */
export function entityHitsOf(items: readonly Item[]): number {
  return items.reduce((sum: number, item) => (isNormalized(item) ? sum + item.nodes.length + item.unreferenced.length : sum), 0);
}

/** The order every search template pages by: the element ID of the row's node (or relationship), the one order that every branch of a union shares. */
export const SEARCH_SORT = 'elementId';

/** What a branch adds to its match to read one page: only the rows after the cursor's element ID, in element ID order, one more than the page. `$cursor` is null on the first page. */
export const keysetOf = (variable: 'n' | 'r'): string => `($cursor IS NULL OR elementId(${variable}) > $cursor.after)`;

/**
 * The position of the page after this one: the element ID of the last row shown, held as an opaque keyset value and never used as a reference. A row whose value is not a node or a relationship
 * with an element ID is a read the gate cannot page, so it has no position.
 */
export function afterLastRow(variable: 'n' | 'r'): (rows: readonly Row[], limit: number) => CursorPosition | undefined {
  return (rows, limit) => {
    const value: unknown = rows[Math.min(rows.length, limit) - 1]?.[variable];
    if (typeof value !== 'object' || value === null || !('elementId' in value) || typeof value.elementId !== 'string') return undefined;
    return { after: value.elementId };
  };
}

/** What a branch of an entity target returns: the node and the entity type of the target, which the gate writes in as a reference to its own list parameter of the targets' entity types, never as text in the statement. */
export const NODE_BRANCH_RETURN = 'RETURN n, @entityType AS entityType';

/** The branch texts of a target of an entity type: the form a RANGE index or a constraint serves, and the form a TEXT index serves. */
export const NODE_BRANCH = {
  value: `MATCH (n:@label) WHERE n.@property IN [$text, $textInteger] AND ${keysetOf('n')} WITH n ORDER BY elementId(n) LIMIT $limit + 1 ${NODE_BRANCH_RETURN}`,
  text: `MATCH (n:@label) WHERE n.@property = $text AND ${keysetOf('n')} WITH n ORDER BY elementId(n) LIMIT $limit + 1 ${NODE_BRANCH_RETURN}`,
} as const;

/**
 * The statement around the branches of an entity search: one row for each node, with the entity types of the targets that matched it, sorted by element ID again and cut at one more than the page.
 * Grouping by the node keeps the keyset on its element ID alone, so a node matched as two types is never split across two pages.
 */
export const NODE_STATEMENT = `CALL { @searchBranches(targets) } WITH n, collect(DISTINCT entityType) AS ${ENTITY_TYPES_COLUMN} ORDER BY elementId(n) LIMIT $limit + 1 RETURN n, ${ENTITY_TYPES_COLUMN}`;

export interface SearchTemplateOptions {
  readonly id: string;
  readonly auditAction: string;
  /** Which list of the mapping the targets are checked against. */
  readonly properties: 'search' | 'reference';
}

/**
 * A template that matches the whole typed text, as stored, against each target property, as the text and, when the text is a canonical 64-bit integer, as that integer too (both parameters),
 * so an index on the property serves each branch and no function touches the property. The branches are written in by the gate from the mapping, joined by `UNION` so an
 * entity found through two properties is one row. It pages by keyset on the element ID: each branch reads the matches after the cursor in element ID order, cut at `$limit + 1`, and so does the
 * combined result, so a node is on one page only. Sorting reads every match of the typed value of a branch (one stored value), which the source's transaction timeout bounds.
 */
export function searchTemplate(options: SearchTemplateOptions): TemplateDefinition {
  return {
    id: options.id,
    version: '1',
    auditAction: options.auditAction,
    cypher: NODE_STATEMENT,
    searchBranches: {
      param: 'targets',
      allowlist: options.properties,
      ...NODE_BRANCH,
    },
    paramsSchema: z.strictObject({ text: searchTextSchema, targets: targetsSchema }).transform((params) => ({ ...params, textInteger: integerCandidateOf(params.text) })),
    scope: 'user',
    paged: true,
    sort: SEARCH_SORT,
    entityParams: [],
    relationshipParams: [],
    usedProperties: (params) => targetsOf(params),
    indexNeeds: (params) => targetsOf(params).map((target) => ({ entityType: target.entityType, property: target.property, accepts: target.match === 'text' ? ('any' as const) : ('value' as const) })),
    readsNothing: (params) => targetsOf(params).length === 0,
    nextPosition: afterLastRow('n'),
    heldOf: entityHitsOf,
    refsOf: () => [],
    normalize: normalizeSearch,
  };
}
