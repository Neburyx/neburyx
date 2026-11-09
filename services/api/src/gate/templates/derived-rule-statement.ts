import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { SourceAllowlist } from '../types.js';

type Rule = NonNullable<SourceAllowlist['derivedRules']>[number];

/** The rule of the mapping a request names, for an entity of the rule's `from` type; anything else is not a request this gate writes a statement for. */
export function ruleOf(allowlist: SourceAllowlist, ruleId: unknown, entityType: unknown): Rule {
  const rule = typeof ruleId === 'string' ? allowlist.derivedRules?.find((candidate) => candidate.id === ruleId) : undefined;
  if (rule === undefined || rule.from !== entityType) throw new AppError('INVALID_REQUEST');
  return rule;
}

/** The entity types of the middle of the rule's chain, in order: every other entry of `via`, starting with the second. */
export const middleTypesOf = (rule: Rule): readonly string[] => rule.via.filter((_entry, index) => index % 2 === 1);

function chainOf(rule: Rule, allowlist: SourceAllowlist, path: boolean): string {
  const typeNames = [...middleTypesOf(rule), rule.to];
  const labels = typeNames.map((type) => allowlist.entityLabels.get(type));
  if (labels.some((label) => label === undefined) || rule.via.length !== 2 * typeNames.length - 1) throw new AppError('INVALID_REQUEST');
  const hops = typeNames.map((_type, hop) => {
    const relationship = quoteName(rule.via[2 * hop] ?? '');
    const last = hop === typeNames.length - 1;
    const end = last ? 'b' : `m${hop + 1}`;
    return `-[:${relationship}]-(${end}:${quoteName(labels[hop] ?? '')})`;
  });
  const pattern = `(a)${hops.join('')}`;
  return path ? `p = ${pattern}` : pattern;
}

function conditionOf(rule: Rule): string {
  const stops = rule.stopListProperty === undefined ? [] : middleTypesOf(rule).map((_type, index) => `coalesce(m${index + 1}.${quoteName(rule.stopListProperty ?? '')}, false) <> true`);
  return ['b <> a', ...stops].join(' AND ');
}

/**
 * The statement of a rule run from one node: the anchor (the first node by element ID with the stable ID, as the entity read finds it), then at most `$limit + 1` distinct other ends reached by the
 * rule's chain, each hop in either direction, then for each end the first chain that supports it as one path. The first `CALL` is lazy, so the read stops once it has the ends it needs and the
 * degree of a shared middle entity does not matter; the second is bounded by its `LIMIT 1`. A middle entity whose stop-list property is true is not followed.
 */
export function derivedRuleStatementOf(allowlist: SourceAllowlist, rule: Rule): string {
  const label = allowlist.entityLabels.get(rule.from);
  const stableId = allowlist.stableIds.get(rule.from);
  if (label === undefined || stableId === undefined) throw new AppError('INVALID_REQUEST');
  const condition = conditionOf(rule);
  return [
    `MATCH (a:${quoteName(label)}) WHERE a.${quoteName(stableId)} IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1`,
    `CALL { WITH a MATCH ${chainOf(rule, allowlist, false)} WHERE ${condition} RETURN DISTINCT b LIMIT $limit + 1 }`,
    `CALL { WITH a, b MATCH ${chainOf(rule, allowlist, true)} WHERE ${condition} RETURN p LIMIT 1 }`,
    'RETURN p',
  ].join('\n');
}
