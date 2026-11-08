import { SEARCH_GROUP_CAP, referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist } from '../types.js';
import { contextBranchesOf } from './related-context-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const RELATED_CONTEXT_ID = 'entity-related-context';

/** One entity of the source, by the reference the answer gave it. */
const referenceSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceValueSchema });

/** A reference as the parameters hold it after the schema: the integer form of the stable ID is beside it. */
const lenientReferenceSchema = z.looseObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: z.string().min(1) });

const withInteger = (reference: z.infer<typeof referenceSchema>) => ({ ...reference, stableInteger: integerCandidateOf(reference.stableId) });

const paramsSchema = z
  .strictObject({ hits: z.array(referenceSchema).max(SEARCH_GROUP_CAP), exact: z.array(referenceSchema).max(SEARCH_GROUP_CAP) })
  .transform((params) => ({ hits: params.hits.map(withInteger), exact: params.exact.map(withInteger) }));

/** One hit's relationship context: the positions of the hit and of the exact match in the lists the read was given, and the relationship's type and direction from the hit's side. */
export interface ContextRow {
  readonly hit: number;
  readonly exact: number;
  readonly relationshipType: string;
  readonly direction: 'out' | 'in';
}

/** What the read answers: at most one row for each hit. */
export interface RelatedContextItem {
  readonly context: readonly ContextRow[];
}

export const isRelatedContextItem = (item: unknown): item is RelatedContextItem => typeof item === 'object' && item !== null && 'context' in item && Array.isArray(item.context);

const rowSchema = z.object({ hi: z.number().int().nonnegative(), ei: z.number().int().nonnegative(), rtype: z.string().min(1), dir: z.enum(['out', 'in']) });

function normalize(rows: readonly Row[], _plan?: Plan): readonly Item[] {
  const context: ContextRow[] = rows.map((row) => {
    const parsed = rowSchema.parse(row);
    return { hit: parsed.hi, exact: parsed.ei, relationshipType: parsed.rtype, direction: parsed.dir };
  });
  return [{ context }];
}

const listOf = (params: Params, name: 'hits' | 'exact'): readonly { readonly entityType: string }[] => {
  const parsed = z.array(z.looseObject({ entityType: z.string() })).safeParse(params[name]);
  return parsed.success ? parsed.data : [];
};

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const types = new Set([...listOf(params, 'hits'), ...listOf(params, 'exact')].map((entry) => entry.entityType));
  return [...types].flatMap((entityType) => {
    const property = allowlist.stableIds.get(entityType);
    return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
  });
}

function refsOf(params: Params): readonly ElementRef[] {
  const parsed = z.array(lenientReferenceSchema).safeParse([...(Array.isArray(params['hits']) ? params['hits'] : []), ...(Array.isArray(params['exact']) ? params['exact'] : [])]);
  return parsed.success ? parsed.data : [];
}

/**
 * Looks for one stored relationship between each of up to 25 related hits and each of up to 25 exact matches of a search, and answers the first for each hit: by the mapping row, then `out` before `in`,
 * then the exact match that comes first. Both ends are found by their `stable_id` index, so a relationship is looked for between two known nodes and neither end's neighbourhood is read; no value of
 * either node is returned, only the positions in the two lists, the relationship type and the direction. The statement is written by the gate from the mapping rows that join the entity types of the two lists.
 */
export const relatedContextTemplate: TemplateDefinition = {
  id: RELATED_CONTEXT_ID,
  version: '1',
  auditAction: 'entity.search_context',
  cypher: '@relatedContext(hits)',
  relatedContext: { hitsParam: 'hits', exactParam: 'exact' },
  referenceLists: ['hits', 'exact'],
  paramsSchema,
  scope: 'user',
  paged: false,
  rows: 'bounded',
  entityParams: [],
  relationshipParams: [],
  indexNeeds,
  readsNothing: (params, allowlist) => {
    const hits = listOf(params, 'hits');
    const exact = listOf(params, 'exact');
    return hits.length === 0 || exact.length === 0 || contextBranchesOf(allowlist, new Set(hits.map((entry) => entry.entityType)), new Set(exact.map((entry) => entry.entityType))).length === 0;
  },
  refsOf,
  normalize,
};
