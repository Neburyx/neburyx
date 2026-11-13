import { z } from 'zod';
import { codePoints, holdsNoNulOrLoneSurrogate } from './investigations.js';
import { MAX_PATTERN_PROBLEMS, PATTERN_LIMITS } from './pattern.js';

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
const definitionPatternShape = { ...savedPatternBase, kind: z.literal('definition'), definition: z.record(z.string(), z.unknown()) };
const presetRunPatternShape = { ...savedPatternBase, kind: z.literal('preset-run'), presetId: text, templateId: text, templateVersion: z.number().int().min(1), params: z.record(z.string(), z.unknown()) };

export const savedPatternSchema = z.discriminatedUnion('kind', [z.strictObject(definitionPatternShape), z.strictObject(presetRunPatternShape)]);

/** What a listed pattern shows of who made it: the creator's current display name, and whether it is the caller's own (no id of another person is shown). */
const listedOwner = { owner: z.strictObject({ name: z.string() }), ownedByYou: z.boolean() };


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

/** Why a saved pattern can no longer run against the current mapping: what a definition names that the mapping no longer has, a definition that no longer passes the schema, a held starting entity of a type the pattern no longer starts at, and the three ways a saved run of a preset can be out of date. */
export const PATTERN_UNAVAILABLE_CODES = [
  'unknown-entity-type',
  'unknown-relationship-type',
  'relationship-does-not-join',
  'unknown-property',
  'not-filterable',
  'bad-definition',
  'anchor-changed',
  'preset-removed',
  'template-changed',
  'params-invalid',
] as const;

/** One reason: the code and, for a definition, the path of the problem (keys and indices only: no name and no value of the definition). */
export const patternUnavailableReasonSchema = z.strictObject({ code: z.enum(PATTERN_UNAVAILABLE_CODES), path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional() });

/** Whether a saved pattern can run against the current mapping: judged without reading the source. */
export const patternAvailabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available') }),
  z.strictObject({ status: z.literal('unavailable'), reasons: z.array(patternUnavailableReasonSchema).min(1).max(MAX_PATTERN_PROBLEMS) }),
]);

/** A pattern as the list shows it: a saved pattern, its creator's name and whether it is the caller's own, and whether it can run now. The save, change, copy and delete answers carry none of these (a pattern just saved is the caller's own and available by construction). */
export const listedPatternSchema = z.discriminatedUnion('kind', [
  savedPatternSchema.options[0].extend({ ...listedOwner, availability: patternAvailabilitySchema }),
  savedPatternSchema.options[1].extend({ ...listedOwner, availability: patternAvailabilitySchema }),
]);

export const patternListResponseSchema = z.strictObject({ items: z.array(listedPatternSchema), nextCursor: z.string().nullable() });

export type PatternListResponse = z.infer<typeof patternListResponseSchema>;
export type PatternAvailability = z.infer<typeof patternAvailabilitySchema>;
export type ListedPattern = z.infer<typeof listedPatternSchema>;

/**
 * `PUT /v1/patterns/{id}`: the pattern's version goes in the body as `expectedVersion`, and at least one of the changeable fields. The name changes either kind; `definition` only a pattern built in the app and `params` only a built-in run
 * (the service refuses the other). `anchor` sets the held starting entity and `null` clears it; `visibility` shares or unshares the pattern and is sent alone; whether the pattern asks for its starting entity is derived from it, so `askForStartingEntity` is not a field.
 */
export const changePatternRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  name: savedPatternNameSchema.optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  anchor: savedPatternAnchorSchema.nullable().optional(),
  /** Makes the pattern visible to everyone on its source or to its creator only; sent alone, it is the whole request (one request, one concern). */
  visibility: z.enum(SAVED_PATTERN_VISIBILITIES).optional(),
});

/** `DELETE /v1/patterns/{id}`: the version after the delete, and when the pattern is removed for good. */
export const deletePatternResponseSchema = z.strictObject({ id: z.uuid(), version: z.number().int().min(1), deletedAt: z.iso.datetime(), purgeAfter: z.iso.datetime() });

export type ChangePatternRequest = z.infer<typeof changePatternRequestSchema>;
export type DeletePatternResponse = z.infer<typeof deletePatternResponseSchema>;
