import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeAggregateSample, normalizeAggregateSummary } from '../normalize/aggregate.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { sampleProperties } from './aggregate-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const AGGREGATE_SAMPLE_ID = 'aggregate-sample';
export const AGGREGATE_SUMMARY_ID = 'aggregate-summary';

const endSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceValueSchema });

/** The relationship type, and the two entities of the aggregate by the references the client holds: the mapping row's `from` first, then its `to`. */
const paramsSchema = z
  .strictObject({ type: z.string().min(1), ends: z.tuple([endSchema, endSchema]) })
  .transform((params) => ({ ...params, ends: params.ends.map((end) => ({ ...end, stableInteger: integerCandidateOf(end.stableId) })) }));

const endsOf = (params: Params): readonly { readonly sourceId: string; readonly entityType: string; readonly stableId: string }[] => {
  const parsed = z.array(z.looseObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() })).safeParse(params['ends']);
  return parsed.success ? parsed.data : [];
};

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  return endsOf(params).flatMap(({ entityType }) => {
    const property = allowlist.stableIds.get(entityType);
    return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
  });
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  const [from, to] = endsOf(params);
  const row = allowlist?.relationshipRows.find((candidate) => candidate.type === params['type'] && candidate.from === from?.entityType && candidate.to === to?.entityType);
  if (allowlist === undefined || row === undefined) return [];
  const evidence = allowlist.evidenceRows.find((candidate) => candidate.type === row.type && candidate.from === row.from && candidate.to === row.to)?.properties ?? [];
  const names = [...(row.observedAt === undefined ? [] : [row.observedAt]), ...sampleProperties(row.filterable ?? [], row, evidence)];
  return names.map((property) => ({ relationshipType: row.type, from: row.from, to: row.to, property }));
}

const refsOf = (params: Params): readonly ElementRef[] => endsOf(params).map(({ sourceId, entityType, stableId }) => ({ sourceId, entityType, stableId }));

function normalizeSample(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the aggregate sample read needs the normalize context');
  return [{ ...normalizeAggregateSample(context, rows) }];
}

function normalizeSummary(rows: readonly Row[]): readonly Item[] {
  return [{ ...normalizeAggregateSummary(rows) }];
}

const shared = { version: '1', paramsSchema, scope: 'user', paged: false, rows: 'one', entityParams: [], referenceLists: ['ends'], relationshipParams: [], indexNeeds, usedProperties, refsOf } as const;

/**
 * Reads both ends of one aggregate and a bounded sample of its members: at most `$limit` of them, each as its observed time and the mapped properties it holds, never a relationship, so no element ID. The statement is written by the gate from
 * the mapping row (see `Template.aggregateRead`); the request holds the relationship type and the two references only.
 */
export const aggregateSampleTemplate: TemplateDefinition = {
  ...shared,
  id: AGGREGATE_SAMPLE_ID,
  auditAction: 'edge.aggregate_sample',
  cypher: '@aggregateRead(type)',
  aggregateRead: { typeParam: 'type', endsParam: 'ends', form: 'sample' },
  normalize: normalizeSample,
};

/** Reads the count and the earliest and latest observed time of every member of one aggregate, apart from the sample, so a read that cannot finish does not take the sample with it. */
export const aggregateSummaryTemplate: TemplateDefinition = {
  ...shared,
  id: AGGREGATE_SUMMARY_ID,
  auditAction: 'edge.aggregate_summary',
  cypher: '@aggregateRead(type)',
  aggregateRead: { typeParam: 'type', endsParam: 'ends', form: 'summary' },
  normalize: normalizeSummary,
};
