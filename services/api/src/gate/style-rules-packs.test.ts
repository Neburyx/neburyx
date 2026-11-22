import type { GraphNode, GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { StyleRuleModel } from '../mapping/model.js';
import { PACKS, packSource } from '../testing/pack-fixtures.js';
import { normalizeModelOf } from './normalize/model.js';
import { styleRulesOf } from './style-rules.js';

const nodeOf = (entityType: string, properties: GraphProperty[]): GraphNode => ({
  ref: { sourceId: 'demo', entityType, stableId: 'x-1' },
  display: { title: 'x', type: entityType },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

/** A property that satisfies the rule's condition, built from the condition alone: the pack's words are the pack's, not this test's. */
function matching(rule: StyleRuleModel): GraphProperty {
  const [first] = rule.when.values;
  if (first === undefined) throw new Error('the rule has no value');
  const key = rule.when.property;
  if (first.class === 'number') {
    const base = Number(first.value);
    const value = rule.when.op === 'gt' ? base + 1 : rule.when.op === 'lt' ? base - 1 : base;
    return { key, value: String(value), dataClass: 'number', masked: false };
  }
  return { key, value: String(first.value), dataClass: first.class, masked: false };
}

/** A property of the same key that does not satisfy the condition. */
function missing(rule: StyleRuleModel): GraphProperty {
  const [first] = rule.when.values;
  const key = rule.when.property;
  if (first?.class === 'number') {
    const edge = Number(first.value);
    return { key, value: String(rule.when.op === 'gt' || rule.when.op === 'gte' ? edge - (rule.when.op === 'gt' ? 0 : 1) : edge + (rule.when.op === 'lt' ? 0 : 1)), dataClass: 'number', masked: false };
  }
  return { key, value: 'no-rule-matches-this-value', dataClass: 'text', masked: false };
}

describe.each(PACKS)('the example style rules of the %s pack', (pack) => {
  const source = packSource(pack);
  const model = normalizeModelOf(source);
  const rulesOf = (type: string) => model.entitiesByType.get(type)?.styleRules ?? [];

  it('are declared, and load with the pack', () => {
    expect(source.styleRules.length).toBeGreaterThan(0);
  });

  it('change the look of the node that matches each of them', () => {
    for (const rule of source.styleRules) expect(styleRulesOf(nodeOf(rule.appliesTo, [matching(rule)]), rulesOf(rule.appliesTo))).toContain(rule.id);
  });

  it('change the look of no node whose value fails the condition, of no other type, and of none whose value is masked by a policy', () => {
    for (const rule of source.styleRules) {
      expect(styleRulesOf(nodeOf(rule.appliesTo, [missing(rule)]), rulesOf(rule.appliesTo))).not.toContain(rule.id);
      expect(styleRulesOf(nodeOf(rule.appliesTo, [{ ...matching(rule), masked: true, maskedBy: 'policy' }]), rulesOf(rule.appliesTo))).not.toContain(rule.id);
      const others = source.entities.map((entity) => entity.type).filter((type) => type !== rule.appliesTo);
      for (const type of others) expect(styleRulesOf(nodeOf(type, [matching(rule)]), rulesOf(type))).not.toContain(rule.id);
    }
  });
});
