import { ASK_TEMPLATE_PARAMS, ASK_TEMPLATE_IDS, type AskEntities, type AskRefusalCause } from './ask.js';

/** The template ids a template intent may name. */
export type AskTemplateId = (typeof ASK_TEMPLATE_IDS)[number];

const PLACEHOLDER = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
/** The text a placeholder takes while the settings of an intent are checked at start-up. */
const PROBE = 'x';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The names of the placeholders in a value, in order of appearance: a string that is exactly `$name`, in any value position (never a key). */
export function placeholderNames(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const found = PLACEHOLDER.exec(value);
    return found?.[1] === undefined ? [] : [found[1]];
  }
  if (Array.isArray(value)) return (value as readonly unknown[]).flatMap(placeholderNames);
  if (isRecord(value)) return Object.values(value).flatMap(placeholderNames);
  return [];
}

function substitute(value: unknown, replace: (name: string) => string): unknown {
  if (typeof value === 'string') {
    const found = PLACEHOLDER.exec(value);
    return found?.[1] === undefined ? value : replace(found[1]);
  }
  if (Array.isArray(value)) return (value as readonly unknown[]).map((entry) => substitute(entry, replace));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, replace)]));
  return value;
}

/**
 * The problems of the settings of a template intent, checked at start-up: its placeholders must be exactly its parameters, and its settings with every placeholder set to a probe text must fit the template's own
 * schema (so a placeholder stands only where the schema takes text). No problem repeats a value.
 */
export function checkTemplateSettings(input: { readonly intent: string; readonly template: string; readonly parameters: readonly string[]; readonly settings: Readonly<Record<string, unknown>> }): readonly string[] {
  const problems: string[] = [];
  const names = [...new Set(placeholderNames(input.settings))];
  const missing = input.parameters.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !input.parameters.includes(name));
  if (missing.length > 0) problems.push(`intent "${input.intent}": the parameter ${missing.join(', ')} has no placeholder in the settings`);
  if (extra.length > 0) problems.push(`intent "${input.intent}": the settings use the placeholder ${extra.join(', ')}, which is not a parameter`);
  const schema = (ASK_TEMPLATE_PARAMS as Readonly<Record<string, (typeof ASK_TEMPLATE_PARAMS)[AskTemplateId] | undefined>>)[input.template];
  if (schema === undefined) return problems;
  const probed = schema.safeParse(substitute(input.settings, () => PROBE));
  if (!probed.success) {
    const paths = [...new Set(probed.error.issues.map((issue) => issue.path.map(String).join('.') || '(the settings)'))];
    problems.push(`intent "${input.intent}": the settings do not fit the template at ${paths.slice(0, 5).join(', ')}`);
  }
  return problems;
}

export type BindResult =
  | { readonly ok: true; readonly template: AskTemplateId; readonly params: unknown }
  | {
      readonly ok: false;
      readonly cause: Extract<AskRefusalCause, 'missing-inputs' | 'extra-inputs' | 'invalid-inputs'>;
      /** Names only: the intent's parameters, the entities found, those missing and those that are no parameter. */
      readonly parameters: readonly string[];
      readonly found: readonly string[];
      readonly missing: readonly string[];
      readonly extra: readonly string[];
    };

/**
 * Binds the entities of a question to a template intent: they must be exactly the intent's parameters, and each replaces its placeholder in the settings; the result must fit the template's schema. Values reach the
 * template only as parameters. A refusal holds names, never a value.
 */
export function bindTemplateIntent(intent: { readonly template: AskTemplateId; readonly parameters: readonly string[]; readonly settings: Readonly<Record<string, unknown>> }, entities: AskEntities): BindResult {
  const found = Object.keys(entities);
  const missing = intent.parameters.filter((name) => !Object.hasOwn(entities, name));
  const extra = found.filter((name) => !intent.parameters.includes(name));
  const refusal = (cause: 'missing-inputs' | 'extra-inputs' | 'invalid-inputs'): BindResult => ({ ok: false, cause, parameters: intent.parameters, found, missing, extra });
  if (missing.length > 0) return refusal('missing-inputs');
  if (extra.length > 0) return refusal('extra-inputs');
  const bound = ASK_TEMPLATE_PARAMS[intent.template].safeParse(substitute(intent.settings, (name) => entities[name] ?? ''));
  return bound.success ? { ok: true, template: intent.template, params: bound.data } : refusal('invalid-inputs');
}

/** Binds the entities of a question to a file-query intent: they must be exactly the intent's parameters, and they are the values the gate gives the query as its parameters. */
export function bindQueryIntent(intent: { readonly parameters: readonly string[] }, entities: AskEntities): { readonly ok: true; readonly values: AskEntities } | Extract<BindResult, { ok: false }> {
  const found = Object.keys(entities);
  const missing = intent.parameters.filter((name) => !Object.hasOwn(entities, name));
  const extra = found.filter((name) => !intent.parameters.includes(name));
  if (missing.length > 0 || extra.length > 0) return { ok: false, cause: missing.length > 0 ? 'missing-inputs' : 'extra-inputs', parameters: intent.parameters, found, missing, extra };
  return { ok: true, values: entities };
}
