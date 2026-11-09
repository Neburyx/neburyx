import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import { normalizeDerivedSupport } from '../normalize/derived-run.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { middleTypesOf, ruleOf } from './derived-rule-statement.js';
import { integerCandidateOf } from './stable-id.js';

export const DERIVED_EDGE_SUPPORT_ID = 'derived-edge-support';

const endSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: referenceValueSchema });

/** The rule, and the two entities of the derived relationship by the references the client holds: the rule's `from` first, then its `to`. */
const paramsSchema = z
  .strictObject({ ruleId: z.string().min(1), ends: z.tuple([endSchema, endSchema]) })
  .transform((params) => ({ ...params, ends: params.ends.map((end) => ({ ...end, stableInteger: integerCandidateOf(end.stableId) })) }));

const endsOf = (params: Params): readonly { readonly entityType: string }[] => {
  const parsed = z.array(z.looseObject({ entityType: z.string() })).safeParse(params['ends']);
  return parsed.success ? parsed.data : [];
};

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  return endsOf(params).flatMap(({ entityType }) => {
    const property = allowlist.stableIds.get(entityType);
    return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
  });
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  if (allowlist === undefined) return [];
  const [from] = endsOf(params);
  const rule = ruleOf(allowlist, params['ruleId'], from?.entityType);
  const property = rule.stopListProperty;
  return property === undefined ? [] : middleTypesOf(rule).map((entityType) => ({ entityType, property }));
}

function refsOf(params: Params): readonly ElementRef[] {
  const parsed = z.array(z.looseObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() })).safeParse(params['ends']);
  return parsed.success ? parsed.data.map(({ sourceId, entityType, stableId }) => ({ sourceId, entityType, stableId })) : [];
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the supports read needs the normalize context');
  return [{ ...normalizeDerivedSupport(context, rows) }];
}

/**
 * Reads the supports of one derived relationship: the chains of the rule between its two ends, at most the limit of them and one more to learn that the read was cut, each through a distinct tuple of middle entities
 * with the first chain of nodes and relationships. The statement is written by the gate from the rule's chain (see `Template.derivedSupport`); the request holds the rule ID and the two references only.
 */
export const derivedEdgeSupportTemplate: TemplateDefinition = {
  id: DERIVED_EDGE_SUPPORT_ID,
  version: '1',
  auditAction: 'edge.derived_support',
  cypher: '@derivedSupport(ruleId)',
  derivedSupport: { ruleParam: 'ruleId', endsParam: 'ends' },
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: [],
  referenceLists: ['ends'],
  relationshipParams: [],
  indexNeeds,
  usedProperties,
  refsOf,
  normalize,
};
