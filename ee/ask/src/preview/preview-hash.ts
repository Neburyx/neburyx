import { timingSafeEqual } from 'node:crypto';
import type { AskResolution } from '@neburyx/contracts';

export interface PreviewParts {
  readonly text: string;
  readonly resolutions: readonly AskResolution[];
  readonly policyVersion: string;
  readonly wordListVersion: string;
}

/** The signing capability the application hands over: it maps a text to 64 lowercase hex characters and keeps its key to itself. */
export type PreviewMac = (canonical: string) => string;

const DOMAIN = 'ask-preview';
const FORMAT_VERSION = 1;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

/** The value with the keys of every object sorted, so equal values have one text. */
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, inner]) => [key, stable(inner)]));
  return value;
}

/** The text that is signed: the rebuilt text, the investigator's resolutions in a fixed order, the policy version and the word-list version, and nothing else. */
export function canonicalPreview(parts: PreviewParts): string {
  const resolutions = parts.resolutions
    .map((resolution) => ({ resolution, key: JSON.stringify(stable(resolution)) }))
    .sort((left, right) => left.resolution.start - right.resolution.start || left.resolution.end - right.resolution.end || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ resolution }) => stable(resolution));
  return JSON.stringify([DOMAIN, FORMAT_VERSION, parts.text, resolutions, parts.policyVersion, parts.wordListVersion]);
}

export function previewHashOf(mac: PreviewMac, parts: PreviewParts): string {
  const hash = mac(canonicalPreview(parts));
  if (!HASH_SHAPE.test(hash)) throw new Error('the preview signature is not 64 lowercase hex characters');
  return hash;
}

/** Whether two hashes are equal, compared in constant time; a value that is not a hash is never equal. */
export function hashesMatch(offered: string, expected: string): boolean {
  if (!HASH_SHAPE.test(offered) || !HASH_SHAPE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(offered, 'hex'), Buffer.from(expected, 'hex'));
}
