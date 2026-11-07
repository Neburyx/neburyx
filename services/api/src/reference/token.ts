import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_REFERENCE_VALUE_CHARACTERS } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { ReferenceKeys } from './keys.js';
import { isWellFormed } from './well-formed.js';

export const TOKEN_VERSION = 'p1';
const PREFIX = `${TOKEN_VERSION}.`;
const IV_BYTES = 16;
const LENGTH_BYTES = 4;

export interface TokenPlace {
  readonly sourceId: string;
  readonly entityType: string;
}

const lengthPrefixed = (bytes: Buffer): Buffer => {
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** What the token's IV authenticates: the version, the source, the entity type and the value, each with its length in front so that no two different tuples give the same bytes. */
const boundInput = (place: TokenPlace, value: Buffer): Buffer => {
  // a lone surrogate in an identity field would be encoded as the replacement character, so two places could share one binding
  if (!isWellFormed(place.sourceId) || !isWellFormed(place.entityType)) throw refused();
  return Buffer.concat([TOKEN_VERSION, place.sourceId, place.entityType].map((text) => lengthPrefixed(Buffer.from(text, 'utf8'))).concat([lengthPrefixed(value)]));
};

const ivOf = (keys: ReferenceKeys, place: TokenPlace, value: Buffer): Buffer => createHmac('sha256', keys.tokenMac).update(boundInput(place, value)).digest().subarray(0, IV_BYTES);

const refused = (): AppError => new AppError('INVALID_REQUEST');

/**
 * The token of a value in a place: deterministic (a synthetic IV, the first bytes of an HMAC over the bound input, so the same value in the same place always gives the same token and two
 * different values or places never do), authenticated (reading it recomputes the IV from the decrypted value) and lossless for any string, because the value is carried as UTF-16 code units.
 */
export function makeToken(keys: ReferenceKeys, place: TokenPlace, value: string): string {
  if (value.length > MAX_REFERENCE_VALUE_CHARACTERS) throw refused();
  const bytes = Buffer.from(value, 'utf16le');
  const iv = ivOf(keys, place, bytes);
  const cipher = createCipheriv('aes-256-ctr', keys.tokenEncryption, iv);
  return PREFIX + Buffer.concat([iv, cipher.update(bytes), cipher.final()]).toString('base64url');
}

/** Whether the text has the shape of a token (the version tag and base64url text); it says nothing about whether the token is valid. */
export const looksLikeToken = (text: string): boolean => text.startsWith(PREFIX);

/**
 * The value a token stands for in a place. Any token that is not exactly one this deployment made for this source and entity type (another place, a changed byte, a truncation, an extension,
 * another spelling of the same bytes, another version) is refused with the same error, which says nothing about which check failed.
 */
export function readToken(keys: ReferenceKeys, place: TokenPlace, token: string): string {
  if (!looksLikeToken(token)) throw refused();
  const encoded = token.slice(PREFIX.length);
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.toString('base64url') !== encoded || raw.length < IV_BYTES || (raw.length - IV_BYTES) % 2 !== 0) throw refused();
  const iv = raw.subarray(0, IV_BYTES);
  const decipher = createDecipheriv('aes-256-ctr', keys.tokenEncryption, iv);
  const bytes = Buffer.concat([decipher.update(raw.subarray(IV_BYTES)), decipher.final()]);
  const expected = ivOf(keys, place, bytes);
  if (!timingSafeEqual(iv, expected)) throw refused();
  const value = bytes.toString('utf16le');
  if (value.length > MAX_REFERENCE_VALUE_CHARACTERS) throw refused();
  return value;
}
