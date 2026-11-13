import { createHash, timingSafeEqual } from 'node:crypto';
import { stable, type PreviewMac } from '../preview/preview-hash.js';

/** The purpose label that opens the text a continue token is signed under, so no other use of the signing capability signs the same text. */
export const CONTINUE_TOKEN_LABEL = 'ask-continue';
const FORMAT_VERSION = 1;
const SHAPE = /^[0-9a-f]{64}$/;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The signed token that lets a plan that stopped as heavy continue: the signing capability of the application over `['ask-continue', 1, planId, sha256 of the parameters]`, the parameters with the keys of
 * every object sorted. It holds no state and no parameter: a plan that was edited (it is another plan), or whose parameters changed, has another token. `params` is any JSON value, so a plan of another
 * kind binds what identifies it by passing that.
 */
export function continueTokenOf(mac: PreviewMac, planId: string, params: unknown): string {
  const token = mac(JSON.stringify([CONTINUE_TOKEN_LABEL, FORMAT_VERSION, planId, sha256(JSON.stringify(stable(params)))]));
  if (!SHAPE.test(token)) throw new Error('the signature of the continue token is not 64 lowercase hex characters');
  return token;
}

/** Whether an offered text is the token of this plan and these parameters, compared in constant time; a text that is not a token of the shape is never one. */
export function verifyContinueToken(mac: PreviewMac, planId: string, params: unknown, offered: unknown): boolean {
  if (typeof offered !== 'string' || !SHAPE.test(offered)) return false;
  return timingSafeEqual(Buffer.from(offered, 'hex'), Buffer.from(continueTokenOf(mac, planId, params), 'hex'));
}
