import { z } from 'zod';

/** A 64-bit integer sent to the adapter as decimal text, which it turns into a driver integer; a JavaScript number cannot hold every value of one. */
export interface TaggedInteger {
  readonly $type: 'integer';
  readonly value: string;
}

const CANONICAL_INTEGER = /^(0|-?[1-9][0-9]*)$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The text as a 64-bit integer when it is the canonical text of one (no leading zeros, no plus sign, no "-0"), else null. */
export function integerCandidateOf(text: string): TaggedInteger | null {
  if (!CANONICAL_INTEGER.test(text)) return null;
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX ? { $type: 'integer', value: text } : null;
}

const taggedIntegerSchema = z.strictObject({ $type: z.literal('integer'), value: z.string() });

export function isTaggedInteger(value: unknown): value is TaggedInteger {
  return taggedIntegerSchema.safeParse(value).success;
}
