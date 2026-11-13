import { z } from 'zod';
import { codePoints, holdsNoNulOrLoneSurrogate } from './investigations.js';
import { PATTERN_LIMITS } from './pattern.js';

const text = z.string().min(1);

/** A name is 1 to `PATTERN_LIMITS.nameLength` code points once trimmed (the database checks the same limit); the service stores the trimmed name. */
export const savedPatternNameSchema = z
  .string()
  .refine(holdsNoNulOrLoneSurrogate, { message: 'a name has no NUL and no unpaired surrogate' })
  .refine((value) => codePoints(value.trim()) >= 1 && codePoints(value.trim()) <= PATTERN_LIMITS.nameLength, { message: 'a name is within the name limit once trimmed' })
  .meta({ maxLength: PATTERN_LIMITS.nameLength });

export const SAVED_PATTERN_KINDS = ['preset-run', 'definition'] as const;
export const SAVED_PATTERN_VISIBILITIES = ['private', 'shared'] as const;

/** The entity a pattern holds as its start, as a reference is shown elsewhere (a keyed type shows its token, never a raw value). */
export const savedPatternAnchorSchema = z.strictObject({ entityType: text, stableId: text });

const savedPatternBase = {
  id: z.uuid(),
  sourceId: text,
  name: text,
  /** True exactly when the pattern holds no starting entity (`anchor` is `null`). */
  askForStartingEntity: z.boolean(),
  anchor: savedPatternAnchorSchema.nullable(),
  visibility: z.enum(SAVED_PATTERN_VISIBILITIES),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().min(1),
};

/** A saved pattern. A `definition` is shown as it was validated and stored (`patternDefinitionSchema` is the one definition; it holds a custom type that an OpenAPI schema cannot describe, so the answer says an object). A saved pattern is a built-in run (a template, its version and its parameters without the starting entity) or a pattern built in the app (a definition). Both are structures, never query text. */
export const savedPatternSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...savedPatternBase, kind: z.literal('definition'), definition: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ...savedPatternBase, kind: z.literal('preset-run'), presetId: text, templateId: text, templateVersion: z.number().int().min(1), params: z.record(z.string(), z.unknown()) }),
]);

/**
 * `POST /v1/patterns`: the source, the name and one of the two kinds. A definition is any object here, so that a bad one is refused with one answer, `INVALID_REQUEST`, and the client asks
 * `POST /v1/patterns/validate` for the list of problems.
 */
export const savePatternRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ sourceId: text, kind: z.literal('definition'), name: savedPatternNameSchema, definition: z.record(z.string(), z.unknown()), anchor: savedPatternAnchorSchema.optional() }),
  z.strictObject({ sourceId: text, kind: z.literal('preset-run'), name: savedPatternNameSchema, presetId: text, params: z.record(z.string(), z.unknown()), anchor: savedPatternAnchorSchema.optional() }),
]);

export const savePatternResponseSchema = savedPatternSchema;

export type SavedPattern = z.infer<typeof savedPatternSchema>;
export type SavePatternRequest = z.infer<typeof savePatternRequestSchema>;

/** The most patterns one page of `GET /v1/patterns` holds, and how many it holds when `limit` is left out (the list conventions of the API). */
export const MAX_PATTERN_LIST_LIMIT = 100;
export const DEFAULT_PATTERN_LIST_LIMIT = 25;

/** `GET /v1/patterns`: the source is required; `limit` is checked against its bounds by the service, since a limit above the maximum is a budget error and not a malformed request. */
export const patternListQuerySchema = z.strictObject({
  sourceId: text,
  limit: z
    .string()
    .regex(/^[0-9]{1,18}$/)
    .transform(Number)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const patternListResponseSchema = z.strictObject({ items: z.array(savedPatternSchema), nextCursor: z.string().nullable() });

export type PatternListResponse = z.infer<typeof patternListResponseSchema>;

/**
 * `PUT /v1/patterns/{id}`: the pattern's version goes in the body as `expectedVersion`, and at least one of the changeable fields. The name changes either kind; `definition` only a pattern built in the app and `params` only a built-in run
 * (the service refuses the other). `anchor` sets the held starting entity and `null` clears it; whether the pattern asks for its starting entity is derived from it, so `askForStartingEntity` is not a field.
 */
export const changePatternRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  name: savedPatternNameSchema.optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  anchor: savedPatternAnchorSchema.nullable().optional(),
});

/** `DELETE /v1/patterns/{id}`: the version after the delete, and when the pattern is removed for good. */
export const deletePatternResponseSchema = z.strictObject({ id: z.uuid(), version: z.number().int().min(1), deletedAt: z.iso.datetime(), purgeAfter: z.iso.datetime() });

export type ChangePatternRequest = z.infer<typeof changePatternRequestSchema>;
export type DeletePatternResponse = z.infer<typeof deletePatternResponseSchema>;
