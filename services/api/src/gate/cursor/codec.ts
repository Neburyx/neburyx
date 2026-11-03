import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { Clock } from '../types.js';

/** A cursor stays valid this long after it is minted: long enough to read a page before asking for the next, short enough to bound a replay. */
export const CURSOR_TTL_MS = 30 * 60_000;

const VERSION = 'v1';

/** What a cursor is bound to: a request that differs in any of these cannot use it. For a list route `target` is the route and `targetVersion` is `1`. */
export interface CursorBinding {
  /** The source the list is scoped to, or null for a list that is not. */
  readonly source: string | null;
  readonly principal: string;
  readonly policyVersion: string;
  readonly filterHash: string;
  readonly sort: string;
  readonly target: string;
  readonly targetVersion: string;
}

/** Where the next page starts: a flat record of text, numbers, booleans and nulls, which the template that minted it knows how to read. */
export type CursorPosition = Readonly<Record<string, string | number | boolean | null>>;

export interface CursorCodec {
  mint(binding: CursorBinding, position: CursorPosition): string;
  /** The position of a cursor that this codec's key signed, that has not expired and that was minted for this binding; any other cursor is `CURSOR_INVALIDATED`. */
  verify(cursor: unknown, binding: CursorBinding): CursorPosition;
}

const positionValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** A flat record of its own fields: text, finite numbers, booleans and nulls. A record with a prototype of its own (a date, a class) is not one, and every own field is checked, `__proto__` included. */
function isPosition(value: unknown): value is CursorPosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.getOwnPropertyNames(value).every((key) => positionValue.safeParse((value as Record<string, unknown>)[key]).success);
}

/** A copy that keeps every own field, a field named `__proto__` as an own field. */
const copyOf = (position: CursorPosition): CursorPosition => Object.fromEntries(Object.getOwnPropertyNames(position).map((key) => [key, position[key]])) as CursorPosition;

const payloadSchema = z.strictObject({
  s: z.string().nullable(),
  p: z.string(),
  pv: z.string(),
  f: z.string(),
  o: z.string(),
  t: z.string(),
  tv: z.string(),
  e: z.number().int(),
  d: z.custom<CursorPosition>(isPosition),
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The text is base64url and has no second spelling: decoding and encoding it again gives the same text. */
function canonicalBase64url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : undefined;
}

function sign(key: Uint8Array, signed: string): Buffer {
  return createHmac('sha256', key).update(signed).digest();
}

const invalid = (): never => {
  throw new AppError('CURSOR_INVALIDATED');
};

export interface CursorCodecOptions {
  /** The signing key; the codec holds it and never shows it. */
  readonly key: Uint8Array;
  readonly clock: Clock;
}

export function createCursorCodec(options: CursorCodecOptions): CursorCodec {
  const { key, clock } = options;
  return {
    mint(binding, position) {
      if (!isPosition(position)) throw new AppError('INTERNAL_ERROR');
      const payload = {
        s: binding.source,
        p: binding.principal,
        pv: binding.policyVersion,
        f: binding.filterHash,
        o: binding.sort,
        t: binding.target,
        tv: binding.targetVersion,
        e: clock() + CURSOR_TTL_MS,
        d: copyOf(position),
      };
      const signed = `${VERSION}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
      return `${signed}.${sign(key, signed).toString('base64url')}`;
    },
    verify(cursor, binding) {
      if (typeof cursor !== 'string') return invalid();
      const parts = cursor.split('.');
      const [version, body, mac] = parts;
      if (parts.length !== 3 || version !== VERSION || body === undefined || mac === undefined) return invalid();
      const macBytes = canonicalBase64url(mac);
      const bodyBytes = canonicalBase64url(body);
      if (macBytes === undefined || bodyBytes === undefined) return invalid();
      const expected = sign(key, `${version}.${body}`);
      if (macBytes.length !== expected.length || !timingSafeEqual(macBytes, expected)) return invalid();
      let decoded: unknown;
      try {
        decoded = JSON.parse(bodyBytes.toString('utf8'));
      } catch {
        return invalid();
      }
      const parsed = payloadSchema.safeParse(decoded);
      if (!parsed.success) return invalid();
      const payload = parsed.data;
      if (clock() >= payload.e) return invalid();
      const matches =
        payload.s === binding.source &&
        payload.p === binding.principal &&
        payload.pv === binding.policyVersion &&
        payload.f === binding.filterHash &&
        payload.o === binding.sort &&
        payload.t === binding.target &&
        payload.tv === binding.targetVersion;
      return matches ? copyOf(payload.d) : invalid();
    },
  };
}
