import type { TemplateDefinition } from '../catalog.js';
import { MAX_HOPS_CEILING } from '../../mapping/budgets.js';
import { normalizePattern } from '../normalize/pattern.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Params, Plan, Row, SourceAllowlist, UsedProperty } from '../types.js';
import { patternParamsSchema, patternRequestOf } from './pattern-request.js';

export const PATTERN_ID = 'pattern';

function indexNeeds(params: Params, allowlist: SourceAllowlist) {
  const entityType = String(params['anchorType']);
  const property = allowlist.stableIds.get(entityType);
  return property === undefined ? [] : [{ entityType, property, accepts: 'value' as const }];
}

function usedProperties(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[] {
  if (allowlist === undefined) return [];
  const request = patternRequestOf(allowlist, params);
  const stops = [...request.stopListed].flatMap(([entityType, properties]) => properties.map((property) => ({ entityType, property })));
  const conditions = request.steps.flatMap((step) =>
    step.conditions.flatMap((condition): UsedProperty[] =>
      condition.on === 'neighbor' ? [{ entityType: step.arrivesAt, property: condition.property }] : step.branches.map((branch) => ({ relationshipType: branch.type, from: branch.from, to: branch.to, property: condition.property })),
    ),
  );
  const times = request.steps.filter((step) => step.windowed).flatMap((step) => step.branches.flatMap((branch) => (branch.observedAt === undefined ? [] : [{ relationshipType: branch.type, from: branch.from, to: branch.to, property: branch.observedAt }])));
  const all = [...stops, ...conditions, ...times];
  return all.filter((used, index) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(used)) === index);
}

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('the pattern run needs the normalize context');
  return [{ ...normalizePattern(context, rows) }];
}

/**
 * Follows the steps of a pattern from the anchor and finds the entities the last step reaches, at most the limit of them and one more to learn that the read was cut, each with the relationships of the shown path and the
 * entities between. The statement is written by the gate from the mapping (see `Template.pattern`); the request holds the entity types, the relationship types, the directions, the conditions, the windows and the stable ID
 * only. A cut means only that there are more matches than were returned.
 */
export const patternTemplate: TemplateDefinition = {
  id: PATTERN_ID,
  version: '1',
  auditAction: 'pattern.run',
  name: 'Pattern',
  description: 'Follows the steps of a stated pattern from one entity and finds the entities the last step reaches.',
  cypher: '@pattern(anchorType)',
  pattern: { entityTypeParam: 'anchorType', stepsParam: 'steps' },
  hops: { listParam: 'steps', max: MAX_HOPS_CEILING },
  paramsSchema: patternParamsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: ['anchorType'],
  referenceParams: { entityType: 'anchorType', stableId: 'stableId' },
  relationshipParams: [],
  indexNeeds,
  usedProperties,
  refsOf: (): readonly ElementRef[] => [],
  normalize,
};
