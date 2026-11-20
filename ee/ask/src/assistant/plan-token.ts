import { createHash, timingSafeEqual } from 'node:crypto';
import { ASK_CONTINUE_LIFETIME_MS, ASSISTANT_PLAN_MAX_CHARACTERS, ASSISTANT_PLAN_PATTERN, assistantPlanSchema, type AssistantPlan, type AssistantPlanStep } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';

const LABEL = 'assistant-confirmation';
/** A plan outlives the row that makes it single-use by a minute, so an expired confirmation is found at its row and said so, not mistaken for a plan that does not verify. */
const PLAN_LIFETIME_MS = ASK_CONTINUE_LIFETIME_MS + 60_000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export type Plan = AssistantPlan;
export type PlanStep = AssistantPlanStep;

/** What a plan is bound to: who may send it, where, for which tool definition and under which masking; and, in the token, when it expires. */
export interface PlanBinding {
  readonly principalId: string;
  readonly sourceId: string;
  readonly investigationId: string;
  /** A fingerprint of the definition of the tool the plan waits on, so a plan does not outlive a change of what that tool runs. */
  readonly definition: string;
  readonly mask: boolean;
}

export const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const hashKeys = (keys: readonly string[]): string => hashText(canonicalText([LABEL, 'view', [...keys].sort()]));

const signedText = (binding: PlanBinding, expiresAtMs: number, payload: string): string =>
  canonicalText([LABEL, 1, binding.principalId, binding.sourceId, binding.investigationId, binding.definition, binding.mask, expiresAtMs, payload]);

/** The plan as the panel holds it: when it expires, the plan as plain text of its own alphabet, and the signature of both with what they are bound to. The label is its own, so it is never valid as a choice or a continue token. */
export function issuePlan(sign: (text: string) => string, binding: PlanBinding, plan: Plan, now: number): string | undefined {
  const expiresAtMs = now + PLAN_LIFETIME_MS;
  const payload = Buffer.from(JSON.stringify(assistantPlanSchema.parse(plan)), 'utf8').toString('base64url');
  const token = `${expiresAtMs}.${payload}.${sign(signedText(binding, expiresAtMs, payload))}`;
  return token.length <= ASSISTANT_PLAN_MAX_CHARACTERS && ASSISTANT_PLAN_PATTERN.test(token) ? token : undefined;
}

/** The plan of a token that is the signature of exactly this binding and has not expired; an expiry further ahead than the lifetime was not issued here. Anything else is undefined. The signature is compared in constant time. */
export function readPlan(sign: (text: string) => string, token: string, binding: PlanBinding, now: number): Plan | undefined {
  if (token.length > ASSISTANT_PLAN_MAX_CHARACTERS || !ASSISTANT_PLAN_PATTERN.test(token)) return undefined;
  const [expiry = '', payload = '', signature = ''] = token.split('.');
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + PLAN_LIFETIME_MS || !SEGMENT.test(payload)) return undefined;
  const expected = Buffer.from(sign(signedText(binding, expiresAtMs, payload)), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const parsed = assistantPlanSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
