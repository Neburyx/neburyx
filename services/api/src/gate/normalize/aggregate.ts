import type { GraphProperty } from '@neburyx/contracts';
import { AppError } from '../../errors.js';
import { sampleProperties, SAMPLE_TIME_KEY, samplePropertyKey } from '../templates/aggregate-statement.js';
import { observedText } from './edge.js';
import { expectedTypesOf, normalizeWithEvidence, type Normalized, type NormalizeContext } from './index.js';
import { firstAndLast } from './observed.js';
import { describeValue } from './node.js';

export type AggregateSampleOrder = 'observed-newest' | 'source-order';

/** One sampled member: its observed time and the mapped properties it holds. It carries no identifier. */
export interface SampledMember {
  readonly observedAt?: string;
  readonly properties: readonly GraphProperty[];
}

/** The two ends of an aggregate, normalized as any nodes are, and the sample the statement returned. */
export interface NormalizedAggregateSample extends Normalized {
  readonly aggregateSample: { readonly order: AggregateSampleOrder; readonly rows: readonly SampledMember[] };
}

/** The count and the earliest and latest observed time of every member, as read; `members` is absent when the read gave no whole number. */
export interface AggregateSummary {
  readonly aggregateSummary: { readonly members?: number; readonly first?: string; readonly last?: string; readonly mixed: boolean };
}

export const isAggregateSample = (item: unknown): item is NormalizedAggregateSample => typeof item === 'object' && item !== null && 'aggregateSample' in item;
export const isAggregateSummary = (item: unknown): item is AggregateSummary => typeof item === 'object' && item !== null && 'aggregateSummary' in item;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function endTypesOf(params: Readonly<Record<string, unknown>> | undefined): readonly [string, string] {
  const ends = params?.['ends'];
  const types = Array.isArray(ends) ? ends.map((end: unknown) => (isObject(end) ? end['entityType'] : undefined)) : [];
  const [from, to] = types;
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('the aggregate read needs the entity types of its ends');
  return [from, to];
}

function rowOf(context: NormalizeContext) {
  const [from, to] = endTypesOf(context.params);
  const row = context.model.relationships.find((candidate) => candidate.type === context.params?.['type'] && candidate.from === from && candidate.to === to);
  if (row === undefined) throw new Error('the aggregate read needs the mapping row of its relationship type');
  return { row, from, to };
}

function memberOf(value: unknown, row: ReturnType<typeof rowOf>['row'], names: readonly string[]): SampledMember {
  const member = isObject(value) ? value : {};
  const observedAt = row.observedAt === undefined ? undefined : observedText(member[SAMPLE_TIME_KEY]);
  const properties = names.flatMap((key, index): GraphProperty[] => {
    const held = member[samplePropertyKey(index)];
    if (held === undefined || held === null) return [];
    const described = describeValue(held);
    return [{ key, ...(described.value === undefined ? {} : { value: described.value }), dataClass: described.dataClass, masked: false }];
  });
  return { ...(observedAt === undefined ? {} : { observedAt }), properties };
}

/** The ends and the sample of an aggregate read. An end the normalizer left out is an unreadable edge; a read that found no end holds no member and the item is empty. */
export function normalizeAggregateSample(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): NormalizedAggregateSample {
  const { row, from, to } = rowOf(context);
  const result = normalizeWithEvidence(context, rows, expectedTypesOf(rows, (_row, column) => (column === 'a' ? [from] : column === 'b' ? [to] : undefined)));
  if (rows.length > 0 && !(result.nodes.some((node) => node.ref.entityType === from) && result.nodes.some((node) => node.ref.entityType === to))) throw new AppError('INTERNAL_ERROR', undefined, 'unreadable-edge');
  const names = sampleProperties(row.projection, row, row.evidence);
  const held = rows.flatMap((entry) => (Array.isArray(entry['sample']) ? entry['sample'] : []));
  const members = held.slice(0, context.limit ?? held.length).map((value) => memberOf(value, row, names));
  const { nodes, unreferenced, edges, dropped, warnings } = result;
  return { nodes, unreferenced, edges, dropped, warnings, aggregateSample: { order: row.observedAt === undefined ? 'source-order' : 'observed-newest', rows: members } };
}

/** The count and observed range of an aggregate read. The earliest and latest time are written as the member gave them; times of different kinds set `mixed`, as the expansion's aggregate does. */
export function normalizeAggregateSummary(rows: readonly Readonly<Record<string, unknown>>[]): AggregateSummary {
  const [entry] = rows;
  if (entry === undefined) return { aggregateSummary: { mixed: false } };
  const members = typeof entry['members'] === 'number' && Number.isSafeInteger(entry['members']) && entry['members'] >= 0 ? entry['members'] : undefined;
  const { first, last, mixed } = firstAndLast([entry['first'], entry['last']].filter((value) => value !== null && value !== undefined));
  return { aggregateSummary: { ...(members === undefined ? {} : { members }), ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }), mixed } };
}
