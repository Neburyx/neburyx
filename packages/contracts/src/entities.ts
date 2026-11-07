import { z } from 'zod';

export const MAX_STABLE_ID_LENGTH = 200;

/** The longest reference a path segment of `GET /v1/entities/…` carries; a longer reference, or one a path cannot carry, is sent in a request body. */
export const MAX_PATH_REFERENCE_LENGTH = 400;

/** The longest value, in UTF-16 code units (what `String.length` counts, and what the token codec encodes), that a reference to a keyed entity can carry: its worst-case JSON text (six bytes a character) plus the rest of a request is within the server's request body bound of 1 MiB, and so is the token made from it. */
export const MAX_REFERENCE_VALUE_CHARACTERS = 100_000;

/** The longest reference text a request body carries, in UTF-16 code units: the token of a value of the largest size (`p1.` and base64url of a 16-byte IV and the value as UTF-16), which is also longer than any raw ID. */
export const MAX_REFERENCE_TEXT_CHARACTERS = 266_691;

const CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/** Whether a reference can travel in a path segment of `GET /v1/entities/…`: within the limit of a segment, with no control character and no unpaired surrogate. Any other reference is sent in a request body. */
export const canCarryInPath = (reference: string): boolean => reference.length <= MAX_PATH_REFERENCE_LENGTH && !CONTROL_OR_SURROGATE.test(reference);

/** A reference as the API returns it, for a request body: for an entity type that is keyed a token, for any other its ID, of any length up to the limit of a body. */
export const referenceTextSchema = z
  .string()
  .min(1)
  .refine((text) => text.length <= MAX_REFERENCE_TEXT_CHARACTERS, { message: 'a reference is at most 266691 UTF-16 code units' })
  .meta({ maxLength: MAX_REFERENCE_TEXT_CHARACTERS });

/** A raw value to be resolved to a reference: of any length up to the limit of a value, with any characters. */
export const referenceValueSchema = z
  .string()
  .min(1)
  .refine((text) => text.length <= MAX_REFERENCE_VALUE_CHARACTERS, { message: 'a value is at most 100000 UTF-16 code units' })
  .meta({ maxLength: MAX_REFERENCE_VALUE_CHARACTERS });

/**
 * `POST /v1/entities/lookup`: one entity of a source by a reference in the body, where a path cannot carry it. `ref` is a reference as the API returned it; `value` is a raw value to resolve, and for an
 * entity type that is keyed it is accepted only when the request is not masked.
 */
export const entityLookupRequestSchema = z.union([
  z.strictObject({ sourceId: z.string().min(1), mask: z.boolean().optional(), ref: z.strictObject({ entityType: z.string().min(1), stableId: referenceTextSchema }) }),
  z.strictObject({ sourceId: z.string().min(1), mask: z.boolean().optional(), value: z.strictObject({ entityType: z.string().min(1), value: referenceValueSchema }) }),
]);
export type EntityLookupRequest = z.infer<typeof entityLookupRequestSchema>;

/** At most 200 characters, counted as characters and not as UTF-16 units, which a length limit of the schema would count. */
export const stableIdSchema = z
  .string()
  .min(1)
  .refine((text) => Array.from(text).length <= MAX_STABLE_ID_LENGTH, { message: 'a stable ID is at most 200 characters' })
  .meta({ maxLength: MAX_STABLE_ID_LENGTH });

const ESCAPE = '~';
const NEEDS_ESCAPE = /^[.~]+$/;
const ESCAPED = /^~[.~]*$/;

/**
 * A value as a path segment, before percent-encoding. A segment of dots is removed from a URL by a browser and by `fetch` even when it is written `%2E`, so a value
 * made only of dots and tildes is sent with a tilde in front; every other value is sent as it is, so `.` is `~.`, `..` is `~..` and `~` is `~~`.
 * A value is never empty, so a bare `~` is the segment of no value: `valueOfPathSegment` returns undefined for it, and a caller refuses it as a malformed segment.
 */
export function pathSegmentOf(value: string): string {
  return NEEDS_ESCAPE.test(value) ? `${ESCAPE}${value}` : value;
}

/** The value a path segment stands for, after percent-decoding; undefined for the bare `~`, which no value is sent as. */
export function valueOfPathSegment(segment: string): string | undefined {
  if (segment === ESCAPE) return undefined;
  return ESCAPED.test(segment) ? segment.slice(ESCAPE.length) : segment;
}

const segmentValue = (): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> =>
  z.string().min(1).transform((segment, context) => {
    const value = valueOfPathSegment(segment);
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'a lone tilde is not a path segment of an entity reference' });
      return z.NEVER;
    }
    return value;
  });

/** The three parts of an entity reference as they travel in the path of `GET /v1/entities/{sourceId}/{entityType}/{stableId}`, after percent-decoding and `valueOfPathSegment`. */
export const entityPathSchema = z.strictObject({
  sourceId: z.string().min(1),
  entityType: segmentValue(),
  stableId: segmentValue().pipe(z.string().min(1).refine(canCarryInPath, { message: 'a reference a path cannot carry is sent in a request body' })),
});

export const entityQuerySchema = z.strictObject({ mask: z.enum(['true', 'false']).optional() });

export type EntityPath = z.infer<typeof entityPathSchema>;
