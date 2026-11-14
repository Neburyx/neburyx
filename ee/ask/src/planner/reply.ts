import { ASK_PLAN_PARAMS, ASK_TEXT_MAX_LENGTH, askPlanSchema, plannedSavedPatternParamsSchema, SAVED_PATTERN_TEMPLATE_ID, type AskPlan, type AskRefusalFamily } from '@neburyx/contracts';
import { isModelFamily } from '../refusal/families.js';

/** What a refusal of the model carries in place of its own words. */
export const MODEL_DECLINED = 'declined';

/** A refusal that holds exactly `kind`, a family the model may name and a reason within the length limit; anything else is read as the family `other`. */
function wellFormedRefusal(value: Record<string, unknown>): value is Record<string, unknown> & { family: AskRefusalFamily } {
  const keys = Object.keys(value);
  const { reason } = value;
  return keys.every((key) => key === 'kind' || key === 'family' || key === 'reason') && typeof reason === 'string' && reason.length <= ASK_TEXT_MAX_LENGTH && isModelFamily(value['family']);
}

const FENCE = /^```[A-Za-z]*\r?\n([\s\S]*?)\r?\n```$/;

export type ReplyReading = { readonly ok: true; readonly plan: AskPlan } | { readonly ok: false; readonly problems: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function problemsOfValue(value: unknown): readonly string[] {
  if (!isRecord(value)) return ['reply: not a JSON object'];
  const { templateId } = value;
  if (value['kind'] === 'plan' && templateId === SAVED_PATTERN_TEMPLATE_ID) {
    const params = plannedSavedPatternParamsSchema.safeParse(value['params']);
    return params.success ? ['plan: a field is missing or unknown'] : params.error.issues.map((issue) => `params.${issue.path.join('.')}: ${issue.code}`.replace(/\.: /, ': '));
  }
  if (value['kind'] === 'plan' && typeof templateId === 'string' && Object.hasOwn(ASK_PLAN_PARAMS, templateId)) {
    const schema = ASK_PLAN_PARAMS[templateId as keyof typeof ASK_PLAN_PARAMS];
    const params = schema.safeParse(value['params']);
    if (!params.success) return params.error.issues.map((issue) => `params.${issue.path.join('.')}: ${issue.code}`.replace(/\.: /, ': '));
    return ['plan: a field is missing or unknown'];
  }
  return [value['kind'] === 'plan' ? 'templateId: not a template of the catalog' : 'kind: not plan or unsupported'];
}

/** The longest reply that is scanned for an object when it is not JSON as a whole; a longer one is refused. */
export const MAX_SCANNED_REPLY = 64 * 1024;
/** The most candidates that may fail (unbalanced, or balanced and not JSON) before the reply is refused: it bounds the scan to this many passes over the text. */
export const MAX_FAILED_STARTS = 16;

/** The end of the braces that open at `start` (the index of the closing brace), or undefined when they never balance. A string and its escapes are tracked only inside the candidate. */
function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

type Scanned = { readonly kind: 'one'; readonly value: unknown } | { readonly kind: 'refused' };

/**
 * The one top-level JSON object of a text that is not JSON as a whole (prose before or after it, or before a fenced block). A candidate starts at `{` and counts when its braces balance and its span parses as an object; after a
 * counted candidate the scan resumes after its end, after a failed one at its start + 1, and a reply with more than `MAX_FAILED_STARTS` failed starts, with no object or with two or more (two equal ones too) is refused. The prose is dropped and never kept.
 */
function scanForObject(text: string): Scanned {
  if (text.length > MAX_SCANNED_REPLY) return { kind: 'refused' };
  const found: unknown[] = [];
  let failed = 0;
  let position = text.indexOf('{');
  while (position !== -1) {
    const end = balancedEnd(text, position);
    let parsed: unknown;
    let counted = false;
    if (end !== undefined) {
      try {
        parsed = JSON.parse(text.slice(position, end + 1));
        counted = isRecord(parsed);
      } catch {
        counted = false;
      }
    }
    if (counted && end !== undefined) {
      found.push(parsed);
      if (found.length > 1) return { kind: 'refused' };
      position = text.indexOf('{', end + 1);
    } else {
      failed += 1;
      if (failed > MAX_FAILED_STARTS) return { kind: 'refused' };
      position = text.indexOf('{', position + 1);
    }
  }
  const [only] = found;
  return found.length === 1 ? { kind: 'one', value: only } : { kind: 'refused' };
}

const NOT_ONE_OBJECT: ReplyReading = { ok: false, problems: ['reply: not one JSON object'] };

/**
 * The plan a reply holds. If the reply, or the one fenced block it is made of, parses as JSON, that value is the reply and nothing is scanned. Otherwise (a fence whose content does not parse included) the one JSON object that the reply has among its prose is the reply (see `scanForObject`).
 * The object is then read exactly as a bare reply is: the schema is as strict as ever (a version written as text stays invalid), and the problems are paths and codes only, never a value of the reply.
 */
export function readReply(reply: string): ReplyReading {
  const trimmed = reply.trim();
  const fenced = FENCE.exec(trimmed)?.[1];
  let value: unknown;
  try {
    value = JSON.parse(fenced ?? trimmed);
  } catch {
    const scanned = scanForObject(trimmed);
    if (scanned.kind === 'refused') return NOT_ONE_OBJECT;
    value = scanned.value;
  }
  if (isRecord(value) && value['kind'] === 'unsupported') {
    // any refusal of the model is a refusal: its family when it names one the model may name, `other` otherwise; its reason is never kept
    return { ok: true, plan: { kind: 'unsupported', family: wellFormedRefusal(value) ? value['family'] : 'other', reason: MODEL_DECLINED } };
  }
  const parsed = askPlanSchema.safeParse(value);
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false, problems: problemsOfValue(value) };
}
