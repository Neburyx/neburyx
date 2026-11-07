import { z } from 'zod';

const UNUSABLE_CHARACTER = /[\p{Cc}\p{Cs}]/u;
const UNUSABLE_MESSAGE = 'must not contain a control character or an unpaired surrogate';

/** Refuses a control character and an unpaired surrogate, which no address can carry. */
export const addressable = <S extends z.ZodString>(schema: S): S => schema.refine((value) => !UNUSABLE_CHARACTER.test(value), { message: UNUSABLE_MESSAGE });

/** Text of one to `limit` characters, counted as characters and not as UTF-16 units, that an address can carry. */
export const addressableTextOfAtMost = (limit: number) =>
  addressable(z.string().min(1).refine((value) => Array.from(value).length <= limit, { message: `must be at most ${limit} characters` }).meta({ maxLength: limit }));
