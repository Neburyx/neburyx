export const AI_SLOT_SHARE_VARIABLE = 'NEBURYX_AI_MAX_SLOT_SHARE';

/** The most of each pool of read slots that AI reads may hold when the setting is not given: it leaves manual exploration at least half. */
export const DEFAULT_AI_SLOT_SHARE = 0.5;

const SHARE_TEXT = /^(?:1(?:\.0+)?|0?\.\d+)$/;

export type AiSlotShare = { readonly ok: true; readonly share: number } | { readonly ok: false; readonly problem: string };

/** An empty value counts as not given. A bad value is a problem that names the variable and never repeats the value. */
export function readAiSlotShare(env: Readonly<Record<string, string | undefined>>): AiSlotShare {
  const given = env[AI_SLOT_SHARE_VARIABLE];
  if (given === undefined || given === '') return { ok: true, share: DEFAULT_AI_SLOT_SHARE };
  const share = SHARE_TEXT.test(given) ? Number(given) : Number.NaN;
  if (!(share > 0 && share <= 1)) return { ok: false, problem: `${AI_SLOT_SHARE_VARIABLE} must be a number above 0 and up to 1` };
  return { ok: true, share };
}
