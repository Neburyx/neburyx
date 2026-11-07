import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { CursorPosition } from '../cursor/codec.js';
import { normalizeExpansion } from '../normalize/expansion.js';
import type { NormalizeContext } from '../normalize/model.js';
import type { Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { expandBranchesOf } from './expand-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const EXPAND_NEIGHBORS_ID = 'expand-neighbors';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const paramsSchema = z
  .strictObject({
    entityType: z.string().min(1),
    stableId: referenceValueSchema,
    neighborType: z.string().min(1),
    relTypes: z.array(z.string().min(1)).min(1).optional(),
    direction: z.enum(['out', 'in', 'both']),
    sort: z.literal('observed'),
  })
  .transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

function branchesOf(params: Params, allowlist: SourceAllowlist) {
  const relTypes = Array.isArray(params['relTypes']) ? params['relTypes'].filter((entry): entry is string => typeof entry === 'string') : undefined;
  const direction = params['direction'];
  return expandBranchesOf(allowlist, String(params['entityType']), String(params['neighborType']), relTypes, direction === 'out' || direction === 'in' ? direction : 'both');
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  if (allowlist === undefined) return [];
  const neighborType = String(params['neighborType']);
  const neighborId = allowlist.stableIds.get(neighborType);
  return [
    ...branchesOf(params, allowlist).flatMap((branch): UsedProperty[] => (branch.observedAt === undefined ? [] : [{ relationshipType: branch.type, from: branch.from, to: branch.to, property: branch.observedAt }])),
    ...(neighborId === undefined ? [] : [{ entityType: neighborType, property: neighborId, use: 'fixed-order' as const }]),
  ];
}

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const property = allowlist.stableIds.get(String(params['entityType']));
  return property === undefined ? [] : [{ entityType: String(params['entityType']), property, accepts: 'value' as const }];
}

const TAGGED_RANKS: Readonly<Record<string, number>> = { dateTime: 1, localDateTime: 2, date: 3, time: 4, localTime: 5, integer: 6 };
const NUMBER_RANK = 6;
const STRING_RANK = 7;

/** The sort value of the last row as a cursor holds it: its text or number, and the rank of its kind, which the next page compares before the value; a row with no sort value holds neither. */
function sortValueOf(value: unknown): { readonly ts: string | number | null; readonly tk: number | null } {
  if (typeof value === 'number') return { ts: value, tk: NUMBER_RANK };
  if (typeof value === 'string') return { ts: value, tk: STRING_RANK };
  const rank = isObject(value) && typeof value['$type'] === 'string' ? TAGGED_RANKS[value['$type']] : undefined;
  if (rank !== undefined && isObject(value) && typeof value['value'] === 'string') return { ts: value['value'], tk: rank };
  return { ts: null, tk: null };
}

function nextPosition(rows: readonly Row[]): CursorPosition | undefined {
  const last = rows.at(-1);
  if (last === undefined) return undefined;
  const { phase, id, rtype, dir, ntype } = last;
  if (typeof phase !== 'number' || typeof id !== 'string' || typeof rtype !== 'string' || typeof dir !== 'string') return undefined;
  return { phase, ...sortValueOf(last['ts']), id, rtype, dir, nType: typeof ntype === 'string' ? ntype : null };
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the expansion read needs the normalize context');
  return [{ ...normalizeExpansion(context, rows) }];
}

/**
 * Reads one page of the relationships between one node and its neighbors of one entity type, newest first by the observed time of the mapping row and undated last, with the neighbors. The node is found
 * as the entity read finds it, the first by element ID. The statement is written by the gate from the mapping rows that join the two entity types (see `Template.expandNeighbors`); the request
 * holds values only. The cursor holds the last row's phase, sort value (with its kind), ID, relationship type and direction, and, for an aggregate, the neighbor's entity type so that a keyed
 * neighbor's ID is held as its token.
 */
export const expandNeighborsTemplate: TemplateDefinition = {
  id: EXPAND_NEIGHBORS_ID,
  version: '1',
  auditAction: 'graph.expand',
  cypher: '@expandNeighbors(entityType)',
  expandNeighbors: { anchorParam: 'entityType', neighborParam: 'neighborType', relTypesParam: 'relTypes', directionParam: 'direction' },
  paramsSchema,
  scope: 'user',
  paged: true,
  sort: 'observed',
  entityParams: ['entityType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  referencePositions: [{ entityType: 'nType', stableId: 'id' }],
  relationshipParams: [],
  indexNeeds,
  readsNothing: (params, allowlist) => branchesOf(params, allowlist).length === 0,
  usedProperties,
  nextPosition,
  refsOf: () => [],
  normalize,
};
