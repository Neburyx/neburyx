import { createHmac } from 'node:crypto';

/** The JSON text of a value with the keys of every object sorted, so that two requests that differ only in the order of keys have the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The filter hash a cursor binds: the HMAC-SHA-256 (hex) under the deployment's filter-hash key of the canonical JSON of the validated parameters, taken before the page limit and the cursor are added. It is keyed so that a parameter of little entropy, such as a phone number, cannot be guessed back from a cursor. */
export function filterHashOf(params: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(params)).digest('hex');
}
