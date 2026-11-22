import { WINDOW_MAX_DAYS, type SourceProfile } from '@neburyx/contracts';

type Preset = SourceProfile['presets'][number];

type FieldKind = 'window' | 'integer' | 'choice';

interface FieldOption {
  readonly value: string;
  readonly text: string;
}

export interface Field {
  /** The name of the parameter in the template's schema. */
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly FieldOption[];
  /** The parameter is a list in the schema and the form sends the one chosen value as a list of one. */
  readonly list?: boolean;
}

/** The preset's own binding of a template parameter: the key the mapping binds it under. */
const BOUND_BY: Readonly<Record<string, keyof Preset['bind']>> = { attributeType: 'attribute', targetType: 'target', via: 'via' };
const CHOICE_OF: Readonly<Record<string, 'entityTypes' | 'relationshipTypes' | 'directions'>> = { attributeType: 'entityTypes', targetType: 'entityTypes', via: 'relationshipTypes', direction: 'directions' };
const DIRECTIONS: readonly FieldOption[] = [
  { value: 'out', text: 'Outgoing' },
  { value: 'in', text: 'Incoming' },
  { value: 'both', text: 'Either direction' },
];

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
/** Zod writes the safe-integer range as the bounds of every integer; it is no bound the contract states. */
const statedMax = (value: unknown): number | undefined => {
  const max = numberOf(value);
  return max === undefined || max >= Number.MAX_SAFE_INTEGER ? undefined : max;
};

/** A parameter name in plain words, for a field the preset gives no label: "minShared" is "Min shared". */
export function plainName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The label of a window field: it always says the zone. */
export const windowLabel = (label: string): string => (/\bUTC\b/.test(label) ? label : `${label} · UTC`);

/** The property that dates the relationship the preset follows, from the profile: the time the window is about. */
export const observedAtOf = (profile: Pick<SourceProfile, 'relationshipTypes'> | undefined, preset: Preset): string | undefined => profile?.relationshipTypes.find((row) => row.type === preset.bind['via'])?.observedAt ?? undefined;

/** The label of a window as the frames write it: the preset's own, else "Observed <the dating property> · UTC". */
export const windowLabelOf = (preset: Pick<Preset, 'labels'>, observedAt: string | undefined): string =>
  windowLabel(preset.labels.find((label) => label.key === 'window')?.text ?? (observedAt === undefined ? 'Window' : `Observed ${observedAt}`));

export const labelOf = (preset: Preset, key: string): string => preset.labels.find((label) => label.key === key)?.text ?? plainName(key);

export interface FieldChoices {
  readonly entityTypes: readonly FieldOption[];
  readonly relationshipTypes: readonly FieldOption[];
  /** The property that dates the relationship the preset follows, for the label of the window. */
  readonly observedAt?: string | undefined;
}

/**
 * The fields of a pattern's form: every parameter the template's JSON Schema declares, but the anchor (chosen apart) and those the preset binds. A parameter that names a type or a relationship is a choice from the mapping,
 * never text; the window is a range of two dates; a number takes the bounds the schema states.
 */
export function fieldsOf(preset: Preset, paramsSchema: Record<string, unknown>, choices: FieldChoices): readonly Field[] {
  const properties = asRecord(paramsSchema['properties']) ?? {};
  const fields: Field[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (name === 'ref') continue;
    const bindKey = BOUND_BY[name];
    if (bindKey !== undefined && preset.bind[bindKey] !== undefined) continue;
    const schema = asRecord(raw) ?? {};
    const label = labelOf(preset, name);
    if (name === 'window') {
      fields.push({ name, label: windowLabelOf(preset, choices.observedAt), kind: 'window' });
      continue;
    }
    const choice = CHOICE_OF[name];
    if (choice !== undefined) {
      const options = choice === 'directions' ? DIRECTIONS : choices[choice];
      fields.push({ name, label, kind: 'choice', options, ...(schema['type'] === 'array' ? { list: true } : {}) });
      continue;
    }
    const items = asRecord(schema['items']);
    const bounded = items ?? schema;
    if (schema['type'] === 'integer' || schema['type'] === 'number') {
      const min = numberOf(bounded['minimum']);
      const max = statedMax(bounded['maximum']);
      fields.push({ name, label, kind: 'integer', ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) });
    }
  }
  return fields;
}

/** What the person has typed: a text for each field, the two dates of a window under `from` and `to`. */
export interface FormValues {
  readonly [field: string]: string;
}

export const windowKey = (name: string, edge: 'from' | 'to'): string => `${name}.${edge}`;

/** Which kind of window the person chose: none, the last n days (`days:7`) or a range of dates (`custom`). */
export const windowModeKey = (name: string): string => `${name}.mode`;

/** Set to `1` while the person is entering a number of their own instead of choosing a step. */
export const customKey = (name: string): string => `${name}.custom`;

export const RELATIVE_WINDOWS: readonly number[] = [7, 14, 30, 90];

const STEPS = [1, 2, 3, 5, 10, 25, 50, 100, 200, 500, 1000];

/** The numbers a field offers to choose from: every whole number when the range is short, else steps inside the range with its upper bound. `whole` is true when every number is offered, so that no number of one's own is needed. */
export function stepsOf(field: Pick<Field, 'min' | 'max'>): { readonly steps: readonly number[]; readonly whole: boolean } {
  const low = field.min ?? 1;
  const high = field.max;
  if (high !== undefined && high - low < 12) return { steps: Array.from({ length: high - low + 1 }, (_, index) => low + index), whole: true };
  const inside = STEPS.filter((step) => step >= low && (high === undefined || step <= high));
  return { steps: high !== undefined && !inside.includes(high) ? [...inside, high] : inside, whole: false };
}

const DAY_MS = 86_400_000;
export const dayOf = (value: string): number => Date.parse(`${value}T00:00:00Z`);
export const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayOf(value)) && new Date(dayOf(value)).toISOString().startsWith(value);

export type Built = { readonly ok: true; readonly params: Record<string, unknown> } | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

export const FORM_ERRORS = {
  windowBoth: 'Set both dates, or clear both.',
  windowOrder: 'The end date is before the start date.',
  windowWide: `The window is at most ${WINDOW_MAX_DAYS} days.`,
  windowDate: 'Use calendar dates.',
  whole: (min: number | undefined, max: number | undefined): string => (max === undefined ? `Enter a whole number of ${min ?? 1} or more.` : `Enter a whole number from ${min ?? 1} to ${max}.`),
} as const;

/** The parameters to send: the anchor and what the person filled; a field left empty sends no key. Refuses a value outside what the schema allows, naming the field. */
export function buildParams(fields: readonly Field[], values: FormValues, anchor: { readonly entityType: string; readonly stableId: string }): Built {
  const params: Record<string, unknown> = { ref: { entityType: anchor.entityType, stableId: anchor.stableId } };
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'window') {
      const mode = values[windowModeKey(field.name)] ?? '';
      const days = /^days:(\d+)$/.exec(mode);
      if (days?.[1] !== undefined) {
        params[field.name] = { days: Number(days[1]) };
        continue;
      }
      const from = (values[windowKey(field.name, 'from')] ?? '').trim();
      const to = (values[windowKey(field.name, 'to')] ?? '').trim();
      if (from === '' && to === '') continue;
      if (from === '' || to === '') errors[field.name] = FORM_ERRORS.windowBoth;
      else if (!isDate(from) || !isDate(to)) errors[field.name] = FORM_ERRORS.windowDate;
      else if (dayOf(from) > dayOf(to)) errors[field.name] = FORM_ERRORS.windowOrder;
      else if ((dayOf(to) - dayOf(from)) / DAY_MS >= WINDOW_MAX_DAYS) errors[field.name] = FORM_ERRORS.windowWide;
      else params[field.name] = { from, to };
      continue;
    }
    const text = (values[field.name] ?? '').trim();
    if (text === '') continue;
    if (field.kind === 'choice') {
      params[field.name] = field.list === true ? [text] : text;
      continue;
    }
    const number = Number(text);
    const min = field.min ?? 1;
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || (field.max !== undefined && number > field.max)) errors[field.name] = FORM_ERRORS.whole(field.min, field.max);
    else params[field.name] = number;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, params };
}
