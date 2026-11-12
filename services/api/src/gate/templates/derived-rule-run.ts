import { referenceValueSchema } from '@neburyx/contracts';
import { z } from 'zod';
import type { TemplateDefinition } from '../catalog.js';
import type { ElementRef, Item, Params, SourceAllowlist, UsedProperty } from '../types.js';
import { middleTypesOf, ruleOf } from './derived-rule-statement.js';
import { integerCandidateOf } from './stable-id.js';
import { normalizeDerivedRun } from '../normalize/derived-run.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { Plan, Row } from '../types.js';

export const DERIVED_RULE_RUN_ID = 'derived-rule-run';

const paramsSchema = z.strictObject({ entityType: z.string().min(1), stableId: referenceValueSchema, ruleId: z.string().min(1) }).transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const entityType = String(params['entityType']);
  const property = allowlist.stableIds.get(entityType);
  return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  if (allowlist === undefined) return [];
  const rule = ruleOf(allowlist, params['ruleId'], params['entityType']);
  const property = rule.stopListProperty;
  return property === undefined ? [] : middleTypesOf(rule).map((entityType) => ({ entityType, property }));
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the rule run needs the normalize context');
  return [{ ...normalizeDerivedRun(context, rows) }];
}

/**
 * Finds the other ends of one derived rule of the mapping from one node, at most the limit of them and one more to learn that the read was cut, each with the first chain of nodes and relationships that supports it.
 * The statement is written by the gate from the rule's chain (see `Template.derivedRule`); the request holds the entity type, the stable ID and the rule ID only. A cut means only that there are more ends than were returned.
 */
export const derivedRuleRunTemplate: TemplateDefinition = {
  id: DERIVED_RULE_RUN_ID,
  version: '1',
  auditAction: 'entity.derived_rule_run',
  description: 'Finds the other ends of one derived rule of the mapping from the anchor, each with the chain that shows the link. Plan this template for a question that asks for the chain that shows the link; a plain question of who shares an attribute plans shared-attribute.',
  cypher: '@derivedRule(ruleId)',
  derivedRule: { ruleParam: 'ruleId', entityTypeParam: 'entityType' },
  paramsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: ['entityType'],
  referenceParams: { entityType: 'entityType', stableId: 'stableId' },
  relationshipParams: [],
  indexNeeds,
  usedProperties,
  refsOf: (): readonly ElementRef[] => [],
  normalize,
};
