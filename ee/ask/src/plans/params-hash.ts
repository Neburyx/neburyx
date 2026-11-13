import { ASK_RUN_PARAMS_LABEL } from '@neburyx/contracts';
import { stable, type PreviewMac } from '../preview/preview-hash.js';

const FORMAT_VERSION = 1;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The keyed hash of the parameters of a plan that the audit of its run holds, instead of any parameter: the signing capability of the application over the canonical text
 * `['ask-run-params', 1, parameters]` with the keys of every object sorted. The label opens the text, as `ask-preview` opens the preview's, so the two uses never sign the same text; the key is the
 * application's, so a short typed value cannot be confirmed by guessing the hash.
 */
export function paramsHashOf(mac: PreviewMac, parameters: unknown): string {
  const hash = mac(JSON.stringify([ASK_RUN_PARAMS_LABEL, FORMAT_VERSION, stable(parameters)]));
  if (!HASH_SHAPE.test(hash)) throw new Error('the signature of the parameters is not 64 lowercase hex characters');
  return hash;
}
