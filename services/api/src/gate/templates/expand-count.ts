import { expandFilterSchema, filterShapeProblem, MAX_FILTERS, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { Item, Row } from '../types.js';
import { branchesOf, canonicalFiltersOf, indexNeeds, usedProperties } from './expand-neighbors.js';
import { integerCandidateOf } from './stable-id.js';

export const EXPAND_COUNT_ID = 'expand-count';

const instant = z.iso.datetime({ offset: true });

const paramsSchema = z
  .strictObject({
    entityType: z.string().min(1),
    stableId: referenceValueSchema,
    neighborType: z.string().min(1),
    relTypes: z.array(z.string().min(1)).min(1).optional(),
    direction: z.enum(['out', 'in', 'both']),
    windowFrom: instant.optional(),
    windowTo: instant.optional(),
    filters: z
      .array(expandFilterSchema)
      .min(1)
      .max(MAX_FILTERS)
      .refine((filters) => filters.every((filter) => filterShapeProblem(filter) === undefined))
      .optional(),
  })
  .refine((params) => (params.windowFrom === undefined) === (params.windowTo === undefined), { message: 'a window has both instants or neither' })
  .refine((params) => params.filters !== undefined || params.windowFrom !== undefined, { message: 'a count has filters or a window' })
  .transform(({ filters, ...params }) => ({ ...params, ...(filters === undefined ? {} : { filters: canonicalFiltersOf(filters) }), stableInteger: integerCandidateOf(params.stableId) }));

/** The one number the read returns, or nothing: a count the server did not answer with a whole number is not a count. */
export interface ExpandCountItem {
  readonly total: number;
  /** With a window: the relationships of a type with an observed time that have no usable time value and are left out of the total. */
  readonly undated?: number;
}

function normalize(rows: readonly Row[]): readonly Item[] {
  const [row] = rows;
  const total = row?.['total'];
  if (rows.length !== 1 || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return [{ unreadable: { rows: String(rows.length) } }];
  const undated = row?.['undated'];
  if (undated !== undefined && (typeof undated !== 'number' || !Number.isSafeInteger(undated) || undated < 0)) return [{ unreadable: { rows: String(rows.length) } }];
  return [{ total, ...(undated === undefined ? {} : { undated }) } satisfies ExpandCountItem];
}

/**
 * Counts the relationships that an expansion with filters reads: the same node, the same mapping rows and the same conditions as the page, one exact number. There is no cap: the count reads what a page
 * reads and ends with the read's transaction timeout, and a count that does not finish is no count. The statement is written by the gate (see `Template.expandNeighbors`, form `count`).
 */
export const expandCountTemplate: TemplateDefinition = {
  id: EXPAND_COUNT_ID,
  version: '1',
  auditAction: 'graph.expand',
  cypher: '@expandNeighbors(entityType)',
  expandNeighbors: { anchorParam: 'entityType', neighborParam: 'neighborType', relTypesParam: 'relTypes', directionParam: 'direction', form: 'count' },
  paramsSchema,
  scope: 'user',
  paged: false,
  rows: 'one',
  entityParams: ['entityType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  relationshipParams: [],
  indexNeeds,
  readsNothing: (params, allowlist) => branchesOf(params, allowlist).length === 0,
  usedProperties,
  refsOf: () => [],
  normalize,
};
