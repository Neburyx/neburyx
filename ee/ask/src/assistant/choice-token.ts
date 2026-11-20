import { timingSafeEqual } from 'node:crypto';
import { ASK_CONTINUE_LIFETIME_MS, ASK_CONTINUE_TOKEN_PATTERN, type AskEntities } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';

const LABEL = 'assistant-choice';

/** What a choice is bound to: who may send it, where, for which intent and which roles, with which values, and under which masking. */
export interface ChoiceBinding {
  readonly principalId: string;
  readonly sourceId: string;
  readonly investigationId: string;
  readonly intent: string;
  /** A fingerprint of the intent's definition in the folder, so a choice does not outlive a change of what the intent runs. */
  readonly definition: string;
  readonly roles: readonly string[];
  readonly entities: AskEntities;
  readonly mask: boolean;
}

const textOf = (binding: ChoiceBinding, expiresAtMs: number): string =>
  canonicalText([LABEL, 1, binding.principalId, binding.sourceId, binding.investigationId, binding.intent, binding.definition, binding.roles, binding.entities, binding.mask, expiresAtMs]);

/** A token for one choice of a clarification: when it expires and the HMAC of what it binds, made with the application's signing capability. Its label is its own, so it is never a token of a heavy stop's Continue, and the other way round. */
export function issueChoiceToken(sign: (text: string) => string, binding: ChoiceBinding, now: number): string {
  const expiresAtMs = now + ASK_CONTINUE_LIFETIME_MS;
  return `${expiresAtMs}.${sign(textOf(binding, expiresAtMs))}`;
}

/** Whether a token is the signature of exactly this binding and has not expired; an expiry further ahead than the lifetime was not issued here. The signature is compared in constant time. */
export function verifyChoiceToken(sign: (text: string) => string, token: string, binding: ChoiceBinding, now: number): boolean {
  if (!ASK_CONTINUE_TOKEN_PATTERN.test(token)) return false;
  const [expiry = '', signature = ''] = token.split('.');
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + ASK_CONTINUE_LIFETIME_MS) return false;
  const expected = Buffer.from(sign(textOf(binding, expiresAtMs)), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
