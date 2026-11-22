import type { GraphNode, IconKey, SourceProfile, StyleRuleProfile, StyleTone } from '@neburyx/contracts';

/** What a node's matched style rules make of its look: the first rule of each effect kind, in the profile's order, decides it, and the labels of the rules that gave it. */
export interface StyleLook {
  readonly badge?: StyleTone;
  readonly color?: StyleTone;
  readonly icon?: IconKey;
  readonly larger?: true;
  readonly labels: readonly string[];
}

/** The look the node's rule ids give it, or nothing when none gives one: an id the profile does not list, or one of a rule for another type, is ignored. Only what is loaded is read; nothing is kept from an earlier reading. */
export function styleLookOf(node: GraphNode, profile: SourceProfile | undefined): StyleLook | undefined {
  const ids = node.display.styleRules;
  if (ids === undefined || ids.length === 0 || profile?.styleRules === undefined) return undefined;
  const matched = new Set(ids);
  const rules = profile.styleRules.filter((rule: StyleRuleProfile) => matched.has(rule.id) && rule.appliesTo === node.ref.entityType);
  let badge: StyleTone | undefined;
  let color: StyleTone | undefined;
  let icon: IconKey | undefined;
  let larger = false;
  const labels: string[] = [];
  for (const { effect, label } of rules) {
    let gave = false;
    if ('badge' in effect && badge === undefined) [badge, gave] = [effect.badge, true];
    else if ('color' in effect && color === undefined) [color, gave] = [effect.color, true];
    else if ('icon' in effect && icon === undefined) [icon, gave] = [effect.icon, true];
    else if ('size' in effect && !larger) [larger, gave] = [true, true];
    if (gave) labels.push(label);
  }
  return labels.length === 0 ? undefined : { ...(badge === undefined ? {} : { badge }), ...(color === undefined ? {} : { color }), ...(icon === undefined ? {} : { icon }), ...(larger ? { larger: true as const } : {}), labels };
}
