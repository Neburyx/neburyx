import { ASK_PLAN_PARAMS, EXPAND_DIRECTIONS, LINKED_HOPS_MAX, MAX_SEARCH_TEXT_LENGTH, MIN_SHARED_MAX, WINDOW_MAX_DAYS, type SourceProfile } from '@neburyx/contracts';
import { codePointCount } from './ask-model.js';
import type { TemplatePlan } from './plan-model.js';

export interface Option {
  readonly value: string;
  readonly text: string;
}

/** A field the person may change. `key` names the parameter; a `window` field stands for the parameter `window` in its three forms. */
export type EditField =
  | { readonly kind: 'number'; readonly key: string; readonly label: string; readonly min: number; readonly max: number | undefined }
  | { readonly kind: 'choice'; readonly key: string; readonly label: string; readonly options: readonly Option[]; readonly multiple: boolean; readonly required: boolean }
  | { readonly kind: 'window'; readonly key: 'window'; readonly label: string }
  | { readonly kind: 'text'; readonly key: string; readonly label: string };

/** What the person typed, by parameter: a text, a list of choices for a multiple choice, and for a window its kind and its parts. */
export type EditValues = Readonly<Record<string, string | readonly string[]>>;
export type EditErrors = Readonly<Record<string, string>>;

export const EDIT_COPY = {
  none: 'Default',
  windowNone: 'No window',
  windowDays: 'Last days',
  windowRange: 'From and to',
  days: 'Days',
  from: 'From (YYYY-MM-DD)',
  to: 'To (YYYY-MM-DD)',
  number: (label: string, min: number, max: number | undefined): string => (max === undefined ? `${label} is a whole number of ${min} or more.` : `${label} is a whole number from ${min} to ${max}.`),
  required: (label: string): string => `Choose at least one for ${label}.`,
  dates: 'Use calendar dates, the first not after the last, less than 3650 days apart.',
  text: (max: number): string => `The text is 1 to ${max} characters.`,
} as const;

const DIRECTION_TEXT: Readonly<Record<string, string>> = { out: 'Outgoing', in: 'Incoming', both: 'Both directions' };

const optionsOf = (values: readonly string[], texts: ReadonlyMap<string, string>, keep: readonly string[]): readonly Option[] =>
  [...new Set([...values, ...keep])].map((value) => ({ value, text: texts.get(value) ?? value }));

interface Vocabulary {
  readonly entityTypes: readonly Option[];
  readonly relationshipTypes: readonly Option[];
  readonly rules: readonly Option[];
}

/** The choices the source's own profile gives; a type the plan already holds stays a choice when the profile is not there, so a plan can always be saved as it is. */
function vocabularyOf(profile: SourceProfile | undefined, plan: TemplatePlan): Vocabulary {
  const params = plan.params as Record<string, unknown>;
  const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  const held = (keys: readonly string[]): string[] => keys.flatMap((key) => strings(params[key]));
  const entityTexts = new Map((profile?.entityTypes ?? []).map((type) => [type.type, type.displayName]));
  return {
    entityTypes: optionsOf((profile?.entityTypes ?? []).map((type) => type.type), entityTexts, held(['attributeType', 'targetType', 'neighborTypes', 'entityTypes'])),
    relationshipTypes: optionsOf((profile?.relationshipTypes ?? []).map((type) => type.type), new Map(), held(['via', 'relTypes'])),
    rules: optionsOf((profile?.derivedRules ?? []).map((rule) => rule.id), new Map(), held(['ruleId'])),
  };
}

const DIRECTIONS: readonly Option[] = EXPAND_DIRECTIONS.map((value) => ({ value, text: DIRECTION_TEXT[value] ?? value }));

/** The fields of a template's parameters that may change, or none for a template whose only parameter is the entity it names. References are never fields: another entity is another question. */
export function editFieldsOf(plan: TemplatePlan, profile: SourceProfile | undefined): readonly EditField[] {
  const vocabulary = vocabularyOf(profile, plan);
  const limit: EditField = { kind: 'number', key: 'limit', label: 'Limit', min: 1, max: undefined };
  const window: EditField = { kind: 'window', key: 'window', label: 'Window' };
  const direction: EditField = { kind: 'choice', key: 'direction', label: 'Direction', options: DIRECTIONS, multiple: false, required: false };
  switch (plan.templateId) {
    case 'shared-attribute':
      return [
        { kind: 'choice', key: 'attributeType', label: 'Attribute', options: vocabulary.entityTypes, multiple: false, required: false },
        { kind: 'choice', key: 'via', label: 'Through', options: vocabulary.relationshipTypes, multiple: false, required: false },
        window,
        { kind: 'number', key: 'minShared', label: 'At least shared', min: 1, max: MIN_SHARED_MAX },
        limit,
      ];
    case 'linked-entities':
      return [
        { kind: 'choice', key: 'targetType', label: 'Target', options: vocabulary.entityTypes, multiple: false, required: false },
        { kind: 'choice', key: 'via', label: 'Through', options: vocabulary.relationshipTypes, multiple: true, required: false },
        direction,
        { kind: 'number', key: 'maxHops', label: 'Steps', min: 1, max: LINKED_HOPS_MAX },
        window,
        limit,
      ];
    case 'expand':
      return [
        { kind: 'choice', key: 'neighborTypes', label: 'Neighbors', options: vocabulary.entityTypes, multiple: true, required: true },
        { kind: 'choice', key: 'relTypes', label: 'Relationships', options: vocabulary.relationshipTypes, multiple: true, required: false },
        direction,
        { kind: 'choice', key: 'sort', label: 'Order', options: [{ value: 'observed', text: 'Newest first' }], multiple: false, required: false },
        window,
        limit,
      ];
    case 'derived-rule-run':
    case 'derived-edge-support':
      return [{ kind: 'choice', key: 'ruleId', label: 'Rule', options: vocabulary.rules, multiple: false, required: true }];
    case 'search':
      return [
        { kind: 'choice', key: 'entityTypes', label: 'Types', options: vocabulary.entityTypes, multiple: true, required: true },
        { kind: 'text', key: 'text', label: 'Text' },
      ];
    case 'entity':
    case 'degree-preview':
      return [];
    default:
      return [];
  }
}

/** The values the form starts from: what the plan holds now. */
export function initialValues(plan: TemplatePlan, fields: readonly EditField[]): EditValues {
  const params = plan.params as Record<string, unknown>;
  const values: Record<string, string | readonly string[]> = {};
  for (const field of fields) {
    const held = params[field.key];
    if (field.kind === 'window') {
      const window = held as { days?: number; from?: string; to?: string } | undefined;
      values['windowKind'] = window === undefined ? 'none' : window.days !== undefined ? 'days' : 'range';
      values['windowDays'] = window?.days === undefined ? '' : String(window.days);
      values['windowFrom'] = window?.from ?? '';
      values['windowTo'] = window?.to ?? '';
    } else if (field.kind === 'choice' && field.multiple) values[field.key] = Array.isArray(held) ? held.filter((entry): entry is string => typeof entry === 'string') : [];
    else values[field.key] = held === undefined ? '' : String(held);
  }
  return values;
}

const WHOLE = /^\d+$/;

export type Built = { readonly ok: true; readonly params: Record<string, unknown> } | { readonly ok: false; readonly errors: EditErrors };

/**
 * The parameters an edit sends: the plan's own with each field's value applied (an empty one removes the parameter, so the source's default applies), every reference carrying the source it is in, and
 * checked against the contract's schema of the template before anything is sent. The server checks the types and rules against the mapping again.
 */
export function buildParams(plan: TemplatePlan, fields: readonly EditField[], values: EditValues, sourceId: string): Built {
  const params: Record<string, unknown> = { ...(plan.params as Record<string, unknown>) };
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'number') {
      const text = String(values[field.key] ?? '').trim();
      if (text === '') delete params[field.key];
      else if (!WHOLE.test(text) || Number(text) < field.min || (field.max !== undefined && Number(text) > field.max)) errors[field.key] = EDIT_COPY.number(field.label, field.min, field.max);
      else params[field.key] = Number(text);
    } else if (field.kind === 'choice') {
      const raw = values[field.key] ?? '';
      const chosen = Array.isArray(raw) ? [...raw] : String(raw) === '' ? [] : [String(raw)];
      if (field.required && chosen.length === 0) errors[field.key] = EDIT_COPY.required(field.label);
      else if (chosen.length === 0) delete params[field.key];
      else params[field.key] = field.multiple ? chosen : chosen[0];
    } else if (field.kind === 'text') {
      const text = String(values[field.key] ?? '');
      if (text.trim() === '' || codePointCount(text) > MAX_SEARCH_TEXT_LENGTH) errors[field.key] = EDIT_COPY.text(MAX_SEARCH_TEXT_LENGTH);
      else params[field.key] = text;
    } else {
      const kind = String(values['windowKind'] ?? 'none');
      if (kind === 'none') delete params['window'];
      else if (kind === 'days') {
        const days = String(values['windowDays'] ?? '').trim();
        if (!WHOLE.test(days) || Number(days) < 1 || Number(days) > WINDOW_MAX_DAYS) errors['window'] = EDIT_COPY.number(EDIT_COPY.days, 1, WINDOW_MAX_DAYS);
        else params['window'] = { days: Number(days) };
      } else params['window'] = { from: String(values['windowFrom'] ?? '').trim(), to: String(values['windowTo'] ?? '').trim() };
    }
  }
  if (Object.keys(errors).length === 0) {
    const parsed = ASK_PLAN_PARAMS[plan.templateId].safeParse(params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        const field = fields.find((candidate) => candidate.key === key);
        if (field !== undefined) errors[field.key] = key === 'window' ? EDIT_COPY.dates : field.kind === 'number' ? EDIT_COPY.number(field.label, 1, undefined) : field.label;
      }
      if (Object.keys(errors).length === 0) errors['form'] = 'These values do not fit this plan.';
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const withSource = (anchor: unknown): unknown => (typeof anchor === 'object' && anchor !== null ? { sourceId, ...anchor } : anchor);
  if (params['ref'] !== undefined) params['ref'] = withSource(params['ref']);
  if (Array.isArray(params['ends'])) params['ends'] = params['ends'].map(withSource);
  return { ok: true, params };
}
