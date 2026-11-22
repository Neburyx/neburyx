import { compareStyleValue, type GraphNode, type GraphProperty } from '@neburyx/contracts';
import type { StyleRuleModel } from '../mapping/model.js';
import type { Normalized } from './normalize/index.js';
import type { GateContext, Item } from './types.js';

/** Whether a property's value matches a rule's condition; a value of another data class, one that cannot be read and one that is masked never match, and nothing is coerced. */
function matches(rule: StyleRuleModel, property: GraphProperty | undefined): boolean {
  if (property === undefined || property.masked || property.value === undefined || property.value === null) return false;
  const { op, values } = rule.when;
  const against = (index: number): -1 | 0 | 1 | undefined => {
    const rule = values[index];
    return rule === undefined ? undefined : compareStyleValue(rule, property.dataClass, property.value);
  };
  switch (op) {
    case 'eq':
      return against(0) === 0;
    case 'in':
      return values.some((_value, index) => against(index) === 0);
    case 'gt':
      return against(0) === 1;
    case 'gte':
      return against(0) === 1 || against(0) === 0;
    case 'lt':
      return against(0) === -1;
    case 'lte':
      return against(0) === -1 || against(0) === 0;
    case 'between': {
      const low = against(0);
      const high = against(1);
      return (low === 0 || low === 1) && (high === 0 || high === -1);
    }
  }
}

/** The ids of the rules a node matches, in mapping order, from the properties it carries after Redact; nothing is read. */
export function styleRulesOf(node: GraphNode, rules: readonly StyleRuleModel[]): string[] {
  return rules.filter((rule) => matches(rule, node.properties.find((property) => property.key === rule.when.property))).map((rule) => rule.id);
}

function isNormalized(item: Item): item is Item & Normalized {
  return Array.isArray(item['nodes']) && Array.isArray(item['edges']);
}

function styled(node: GraphNode, context: GateContext): GraphNode {
  const rules = context.model.entitiesByType.get(node.ref.entityType)?.styleRules;
  if (rules === undefined) return node;
  const matched = styleRulesOf(node, rules);
  return matched.length === 0 ? node : { ...node, display: { ...node.display, styleRules: matched } };
}

/**
 * The style stage: right after the redact stage, each node of a normalized result gets the ids of the style rules it matches, worked out from the properties it carries once Redact has run (a property that is masked or was removed gives no match).
 * It runs in the gate, not inside the redact stage, because that stage can be replaced. It reads nothing and adds no statement; an item that is not a normalized result passes through.
 */
export function styledItems(items: readonly Item[], context: GateContext): readonly Item[] {
  return items.map((item) => (isNormalized(item) ? { ...item, nodes: item.nodes.map((node) => styled(node, context)) } : item));
}
