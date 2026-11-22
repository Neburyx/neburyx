import { compareStyleValue, filterValueSchema, ICON_KEYS, isOrdered, MAX_FILTER_VALUES, STYLE_EFFECT_KINDS, STYLE_TONES, type FilterKind, type StyleEffectKind, type StyleValue } from '@neburyx/contracts';
import type { EntityModel, StyleEffectModel, StyleRuleModel } from './model.js';
import type { RawStyleRule } from './schema.js';

type Report = (segments: readonly (string | number)[], reason: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ORDERING = ['gt', 'gte', 'lt', 'lte'] as const;

/** A value from the file as a typed rule value, or why it does not suit: the declared kind when there is one, else a text, a number or true or false. */
function valueOf(raw: unknown, kind: FilterKind | undefined): { readonly value: StyleValue } | { readonly problem: string } {
  const wanted: FilterKind | undefined = kind ?? (typeof raw === 'string' ? 'text' : typeof raw === 'number' ? 'number' : typeof raw === 'boolean' ? 'boolean' : undefined);
  if (wanted === undefined) return { problem: 'must be a text, a number, true or false' };
  const parsed = filterValueSchema.safeParse({ kind: wanted, value: raw });
  if (!parsed.success) return { problem: kind === undefined ? `is not a valid ${wanted} value` : `does not suit the declared kind ${kind} of the property` };
  return { value: { class: wanted, value: parsed.data.value } };
}

function effectOf(raw: unknown, at: readonly (string | number)[], report: Report): StyleEffectModel | undefined {
  if (!isRecord(raw)) {
    report(at, `must have exactly one of ${STYLE_EFFECT_KINDS.join(', ')}`);
    return undefined;
  }
  const keys = Object.keys(raw);
  const unknown = keys.find((key) => !(STYLE_EFFECT_KINDS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    report([...at, unknown], `is not one of ${STYLE_EFFECT_KINDS.join(', ')}`);
    return undefined;
  }
  if (keys.length !== 1) {
    report(at, `must have exactly one of ${STYLE_EFFECT_KINDS.join(', ')}`);
    return undefined;
  }
  const kind = keys[0] as StyleEffectKind;
  const value = raw[kind];
  if (kind === 'badge' || kind === 'color') {
    const tone = STYLE_TONES.find((candidate) => candidate === value);
    if (tone === undefined) report([...at, kind], `must be one of ${STYLE_TONES.join(', ')}`);
    return tone === undefined ? undefined : { kind, tone };
  }
  if (kind === 'icon') {
    const icon = ICON_KEYS.find((candidate) => candidate === value);
    if (icon === undefined) report([...at, kind], `must be one of ${ICON_KEYS.join(', ')}`);
    return icon === undefined ? undefined : { kind, icon };
  }
  if (value !== 'larger') report([...at, kind], 'must be larger');
  return value === 'larger' ? { kind: 'size', size: 'larger' } : undefined;
}

/** The rule's condition: its values typed by the property's declared kind, with the operator's own shape checked. */
function conditionOf(rule: RawStyleRule, entity: EntityModel, at: readonly (string | number)[], report: Report): StyleRuleModel['when'] | undefined {
  const { property, op, value } = rule.when;
  const kind = entity.filterable.includes(property) ? entity.kinds?.[property] : undefined;
  const whenAt = [...at, 'when'];
  const ordering = (ORDERING as readonly string[]).includes(op) || op === 'between';
  if (ordering && (kind === undefined || !isOrdered(kind))) {
    report([...whenAt, 'op'], 'needs a filterable property with a declared kind (number, date or time)');
    return undefined;
  }
  const typed = (raw: unknown, segments: readonly (string | number)[]): StyleValue | undefined => {
    const made = valueOf(raw, kind);
    if ('problem' in made) {
      report(segments, made.problem);
      return undefined;
    }
    return made.value;
  };
  const valueAt = [...whenAt, 'value'];
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_VALUES) {
      report(valueAt, `must be a list of 1 to ${MAX_FILTER_VALUES} values`);
      return undefined;
    }
    const values = value.map((entry, index) => typed(entry, [...valueAt, index]));
    if (!values.every((entry): entry is StyleValue => entry !== undefined)) return undefined;
    if (values.some((entry) => entry.class !== values[0]?.class)) {
      report(valueAt, 'must hold values of one kind');
      return undefined;
    }
    return { property, op, values };
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      report(valueAt, 'must be a list of two values, the low end and the high end');
      return undefined;
    }
    const [low, high] = [typed(value[0], [...valueAt, 0]), typed(value[1], [...valueAt, 1])];
    if (low === undefined || high === undefined) return undefined;
    if (compareStyleValue(low, high.class, high.value) === -1) {
      report(valueAt, 'has a low end above its high end');
      return undefined;
    }
    return { property, op, values: [low, high] };
  }
  if (Array.isArray(value) || value === undefined || value === null) {
    report(valueAt, value === undefined ? 'is required' : 'must be one value');
    return undefined;
  }
  const single = typed(value, valueAt);
  return single === undefined ? undefined : { property, op, values: [single] };
}

/**
 * The typed style rules of a source, in mapping order. A rule is refused, with the path of what is wrong and no value from the file, when its type is not an entity type of the source (a relationship type included), its
 * property is a personal-data property or is not mapped for the type, its id repeats, its operator does not suit the property's declared kind, a value does not suit it, or its effect is not exactly one of the closed set.
 */
export function buildStyleRules(rules: readonly RawStyleRule[], entities: readonly EntityModel[], relationshipTypes: ReadonlySet<string>, projections: ReadonlyMap<string, readonly string[]>, base: readonly (string | number)[], report: Report): StyleRuleModel[] {
  const byType = new Map(entities.map((entity) => [entity.type, entity]));
  const seen = new Set<string>();
  const built: StyleRuleModel[] = [];
  rules.forEach((rule, index) => {
    const at = [...base, index];
    let ok = true;
    let readable = false;
    const refuse = (segments: readonly (string | number)[], reason: string): void => {
      ok = false;
      report(segments, reason);
    };
    if (seen.has(rule.id)) refuse([...at, 'id'], `repeats the style rule id ${rule.id}`);
    seen.add(rule.id);
    const entity = byType.get(rule.applies_to);
    if (entity === undefined) {
      refuse([...at, 'applies_to'], relationshipTypes.has(rule.applies_to) ? `names ${rule.applies_to}, which is a relationship type: style rules apply to entity types only` : `names ${rule.applies_to}, which is not an entity type of this source`);
    } else if (entity.pii.includes(rule.when.property)) {
      refuse([...at, 'when', 'property'], `is a personal-data property of entity type ${entity.type}, which a style rule cannot read`);
    } else if (!(projections.get(entity.type) ?? []).includes(rule.when.property)) {
      refuse([...at, 'when', 'property'], `is not a property mapped for entity type ${entity.type}`);
    } else {
      readable = true;
    }
    const effect = effectOf(rule.effect, [...at, 'effect'], (segments, reason) => refuse(segments, reason));
    const when = entity === undefined || !readable ? undefined : conditionOf(rule, entity, at, (segments, reason) => refuse(segments, reason));
    if (ok && effect !== undefined && when !== undefined) built.push({ id: rule.id, label: rule.label, appliesTo: rule.applies_to, when, effect });
  });
  return built;
}
