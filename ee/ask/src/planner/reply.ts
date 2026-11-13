import { ASK_PLAN_PARAMS, ASK_TEXT_MAX_LENGTH, askPlanSchema, type AskPlan, type AskRefusalFamily } from '@neburyx/contracts';
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
  if (value['kind'] === 'plan' && typeof templateId === 'string' && Object.hasOwn(ASK_PLAN_PARAMS, templateId)) {
    const schema = ASK_PLAN_PARAMS[templateId as keyof typeof ASK_PLAN_PARAMS];
    const params = schema.safeParse(value['params']);
    if (!params.success) return params.error.issues.map((issue) => `params.${issue.path.join('.')}: ${issue.code}`.replace(/\.: /, ': '));
    return ['plan: a field is missing or unknown'];
  }
  return [value['kind'] === 'plan' ? 'templateId: not a template of the catalog' : 'kind: not plan or unsupported'];
}

/** The plan a reply holds: one JSON object, alone or in one fenced block, that is an `AskPlan`; otherwise the problems, as paths and codes only, never a value of the reply. */
export function readReply(reply: string): ReplyReading {
  const trimmed = reply.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, problems: ['reply: not one JSON object'] };
  }
  if (isRecord(value) && value['kind'] === 'unsupported') {
    // any refusal of the model is a refusal: its family when it names one the model may name, `other` otherwise; its reason is never kept
    return { ok: true, plan: { kind: 'unsupported', family: wellFormedRefusal(value) ? value['family'] : 'other', reason: MODEL_DECLINED } };
  }
  const parsed = askPlanSchema.safeParse(value);
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false, problems: problemsOfValue(value) };
}
