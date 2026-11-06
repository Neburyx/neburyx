import { z } from 'zod';

export const MAX_STABLE_ID_LENGTH = 200;

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
  stableId: segmentValue().pipe(stableIdSchema),
});

export const entityQuerySchema = z.strictObject({ mask: z.enum(['true', 'false']).optional() });

export type EntityPath = z.infer<typeof entityPathSchema>;
