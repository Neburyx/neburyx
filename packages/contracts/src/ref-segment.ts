const BASE64URL = /^[A-Za-z0-9_-]+$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}


/** The unpadded base64url text of the JSON of a value: the path segment of a reference. The caller percent-encodes it for a URL. */
export function segmentOfJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The JSON a path segment holds, or undefined for text over the bound, a character outside the unpadded base64url alphabet, or text that is not UTF-8 JSON. */
export function jsonOfSegment(segment: string, maxLength: number): unknown {
  if (segment.length === 0 || segment.length > maxLength) return undefined;
  const bytes = base64UrlToBytes(segment);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
