import { ASK_PLAN_PARAMS, askPlanSchema, type AskPlan } from '@neburyx/contracts';

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
  const parsed = askPlanSchema.safeParse(value);
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false, problems: problemsOfValue(value) };
}
