import { timingSafeEqual } from 'node:crypto';
import { ASK_CONTINUE_LABEL, ASK_CONTINUE_LIFETIME_MS, ASK_CONTINUE_TOKEN_PATTERN, type AskEntities } from '@neburyx/contracts';
import { canonicalText } from './canonical.js';

export interface ContinueBinding {
  readonly principalId: string;
  readonly sourceId: string;
  readonly intent: string;
  /** A fingerprint of the intent's definition in the folder, so a token does not outlive a change of what the intent runs. */
  readonly definition: string;
  readonly entities: AskEntities;
  readonly mask: boolean;
}

const textOf = (binding: ContinueBinding, expiresAtMs: number): string =>
  canonicalText([ASK_CONTINUE_LABEL, 1, binding.principalId, binding.sourceId, binding.intent, binding.definition, binding.entities, binding.mask, expiresAtMs]);

/** A token that lets the person continue one answer that stopped as heavy: when it expires and the HMAC of what it binds, made with the application's signing capability. It holds no plan and is stored nowhere. */
export function issueContinueToken(sign: (text: string) => string, binding: ContinueBinding, now: number): string {
  const expiresAtMs = now + ASK_CONTINUE_LIFETIME_MS;
  return `${expiresAtMs}.${sign(textOf(binding, expiresAtMs))}`;
}

/** Whether a token is the signature of exactly this binding and has not expired; an expiry further ahead than the lifetime was not issued here. The signature is compared in constant time. */
export function verifyContinueToken(sign: (text: string) => string, token: string, binding: ContinueBinding, now: number): boolean {
  if (!ASK_CONTINUE_TOKEN_PATTERN.test(token)) return false;
  const [expiry = '', signature = ''] = token.split('.');
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + ASK_CONTINUE_LIFETIME_MS) return false;
  const expected = Buffer.from(sign(textOf(binding, expiresAtMs)), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
