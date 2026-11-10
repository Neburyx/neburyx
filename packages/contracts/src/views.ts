import { z } from 'zod';
import { INVESTIGATION_STATUSES, codePoints, draftSchema, holdsNoNulOrLoneSurrogate, investigationSaveSchema, investigationTitleSchema, notesSchema } from './investigations.js';

/** The longest name of a named view, in characters (the database checks the same limit). */
export const MAX_VIEW_NAME_LENGTH = 120;

const boundedText = (maxLength: number, what: string) =>
  z
    .string()
    .min(1)
    .refine(holdsNoNulOrLoneSurrogate, { message: `${what} has no NUL and no unpaired surrogate` })
    .refine((value) => codePoints(value) <= maxLength, { message: `${what} is at most ${maxLength} characters` })
    .meta({ maxLength });

export const viewNameSchema = boundedText(MAX_VIEW_NAME_LENGTH, 'a view name');

const versionSchema = z.number().int().min(1);

/** `POST /v1/investigations/{id}/views`; the draft's `version` goes in `If-Match`. The title and the version of the investigation it was read at come together or not at all. */
export const saveViewRequestSchema = z
  .strictObject({ name: viewNameSchema, notes: notesSchema, title: investigationTitleSchema.optional(), expectedInvestigationVersion: versionSchema.optional() })
  .refine((request) => (request.title === undefined) === (request.expectedInvestigationVersion === undefined), { message: 'a title and the version of the investigation it replaces come together' });

/** Who saved a view, by the name the people of the workspace see. */
export const viewAuthorSchema = z.strictObject({ name: z.string().min(1) });

/** A named view without its documents: what the Views panel lists. */
export const namedViewSchema = z.strictObject({ id: z.uuid(), name: viewNameSchema, notes: notesSchema, savedBy: viewAuthorSchema, createdAt: z.iso.datetime(), version: versionSchema });

export const saveViewResponseSchema = z.strictObject({
  view: namedViewSchema,
  draft: z.strictObject({ version: versionSchema, notes: notesSchema, basedOnViewId: z.uuid() }),
  save: z.strictObject({ state: z.literal('saved'), savedAt: z.iso.datetime() }),
  investigation: z.strictObject({ title: investigationTitleSchema, version: versionSchema }).optional(),
});

export type SaveViewRequest = z.infer<typeof saveViewRequestSchema>;
export type NamedView = z.infer<typeof namedViewSchema>;
export type SaveViewResponse = z.infer<typeof saveViewResponseSchema>;

/** The rows `GET /v1/investigations/{id}/views` returns when `limit` is left out, and the most it allows (`docs/api-conventions.md`, Pagination). */
export const DEFAULT_VIEW_PAGE = 25;
export const MAX_VIEW_PAGE = 100;

/** `limit` is checked against its bounds by the route, since a limit above the maximum is a budget error and not a malformed request. */
export const viewListQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,18}$/)
    .transform(Number)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const viewListResponseSchema = z.strictObject({
  items: z.array(namedViewSchema),
  nextCursor: z.string().nullable(),
  count: z.strictObject({ value: z.number().int().nonnegative(), quality: z.literal('exact'), scope: z.literal('named-views') }),
  draft: z.strictObject({ basedOnViewId: z.uuid().nullable(), updatedAt: z.iso.datetime() }),
});

/** `PUT /v1/investigations/{id}/views/{viewId}`; the view's `version` goes in `If-Match`. Only the name changes. */
export const renameViewRequestSchema = z.strictObject({ name: viewNameSchema });

export type ViewListResponse = z.infer<typeof viewListResponseSchema>;

/** A named view of one of the caller's investigations, with the investigation it belongs to: what the Saved views tab lists. */
export const ownedViewSchema = z.strictObject({
  id: z.uuid(),
  name: viewNameSchema,
  investigation: z.strictObject({ id: z.uuid(), title: investigationTitleSchema, sourceId: z.string().min(1), sourceAlias: z.string().min(1), status: z.enum(INVESTIGATION_STATUSES) }),
  savedBy: viewAuthorSchema,
  createdAt: z.iso.datetime(),
  version: versionSchema,
});

export const ownedViewListResponseSchema = z.strictObject({
  items: z.array(ownedViewSchema),
  nextCursor: z.string().nullable(),
  count: z.strictObject({ value: z.number().int().nonnegative(), quality: z.literal('exact'), scope: z.literal('named-views') }),
});

export type OwnedView = z.infer<typeof ownedViewSchema>;
export type OwnedViewListResponse = z.infer<typeof ownedViewListResponseSchema>;
export type RenameViewRequest = z.infer<typeof renameViewRequestSchema>;

/** `POST /v1/investigations/{id}/views/{viewId}/delete`; the view's `version` goes in `If-Match`. The note says why and is kept with the deleted view; it is optional, and an empty one is stored as none. */
export const deleteViewRequestSchema = z.strictObject({ note: notesSchema.optional() });

/** The investigation's views after the delete: the draft (its `basedOnViewId` is null when the view it was based on is deleted, which this delete may have just done), the save state and the exact number of views that are left. */
export const deleteViewResponseSchema = z.strictObject({
  id: z.uuid(),
  version: versionSchema,
  deletedAt: z.iso.datetime(),
  draft: z.strictObject({ version: versionSchema, basedOnViewId: z.uuid().nullable() }),
  save: investigationSaveSchema,
  count: z.strictObject({ value: z.number().int().nonnegative(), quality: z.literal('exact'), scope: z.literal('named-views') }),
});

export type DeleteViewRequest = z.infer<typeof deleteViewRequestSchema>;
export type DeleteViewResponse = z.infer<typeof deleteViewResponseSchema>;

/** `POST /v1/investigations/{id}/views/{viewId}/restore`: the draft as it is now, which holds what the view held, and that it equals the view. */
export const restoreViewResponseSchema = z.strictObject({
  draft: draftSchema.extend({ basedOnViewId: z.uuid() }),
  save: z.strictObject({ state: z.literal('saved'), savedAt: z.iso.datetime() }),
});

export type RestoreViewResponse = z.infer<typeof restoreViewResponseSchema>;
