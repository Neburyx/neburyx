import { z } from 'zod';
import { edgeRefSchema, elementRefSchema } from './graph.js';
import type { InvestigationSave } from './investigations.js';

/** The most entries (one for each summary that was copied) the AI notes of one draft hold. An engineering bound with no source, chosen to keep a draft row small; revisited if analysts hit it. */
export const AI_NOTES_MAX_ENTRIES = 20;

/** The most sentences an entry holds: the summary's own maximum. */
export const AI_NOTES_MAX_SENTENCES = 12;

/** The most placeholders, and the most cited elements, one sentence holds. */
/** The most cited elements and placeholders one stored sentence holds; a sentence past it is not storable, so what is copied can always be read. */
export const AI_NOTES_MAX_SLOTS = 50;

/** What the application knows of an entry the extension appends: whom it came from by its token, and how large it is; the rest is the extension's own. */
export const aiNotesEntryInputSchema = z.looseObject({ tokenId: z.string().min(1), sentences: z.array(z.unknown()), inputRefs: z.array(z.unknown()) });

export type AiNotesEntryInput = z.infer<typeof aiNotesEntryInputSchema>;

/** The time fields of a relationship a sentence may state, as the assembled text of a summary names them. */
export const AI_NOTES_TIME_FIELDS = ['observedAt', 'observedFirst', 'observedLast', 'validFrom', 'validTo'] as const;

const entityDescriptor = z.strictObject({ kind: z.literal('entity'), ref: elementRefSchema });

/** What a placeholder of stored AI text stands for, so that it can be resolved again for any viewer. */
export const aiNotesDescriptorSchema = z.discriminatedUnion('kind', [
  entityDescriptor,
  z.strictObject({ kind: z.literal('type'), of: z.discriminatedUnion('kind', [entityDescriptor, z.strictObject({ kind: z.literal('relationship'), ref: edgeRefSchema })]) }),
  z.strictObject({ kind: z.literal('count'), relationship: edgeRefSchema, scope: z.literal('members') }),
  z.strictObject({ kind: z.literal('time'), relationship: edgeRefSchema, field: z.enum(AI_NOTES_TIME_FIELDS) }),
]);

export type AiNotesDescriptor = z.infer<typeof aiNotesDescriptorSchema>;

export const aiNotesPlaceholderSchema = z.strictObject({ name: z.string().regex(/^‹[a-z][a-z0-9-]*#[1-9][0-9]*›$/u), descriptor: aiNotesDescriptorSchema });

export type AiNotesPlaceholder = z.infer<typeof aiNotesPlaceholderSchema>;

const sentRefSchema = z.discriminatedUnion('kind', [z.strictObject({ key: z.string().min(1), kind: z.literal('entity'), ref: elementRefSchema }), z.strictObject({ key: z.string().min(1), kind: z.literal('relationship'), ref: edgeRefSchema })]);

/** One summary as it is kept in the AI notes of a draft: placeholders and listed words, the descriptors that resolve the placeholders, the elements cited and every element the generation read. */
export const storedAiNotesEntrySchema = z.strictObject({
  tokenId: z.string().min(1),
  generatedBy: z.string().min(1),
  modelRef: z.string().min(1),
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  generatedAt: z.iso.datetime(),
  wordListVersion: z.number().int().nonnegative(),
  label: z.literal('AI-drafted'),
  sentences: z.array(z.strictObject({ text: z.string().min(1), placeholders: z.array(aiNotesPlaceholderSchema).max(AI_NOTES_MAX_SLOTS), cites: z.array(sentRefSchema).max(AI_NOTES_MAX_SLOTS) })).max(AI_NOTES_MAX_SENTENCES),
  inputRefs: z.array(sentRefSchema),
});

export type StoredAiNotesEntry = z.infer<typeof storedAiNotesEntrySchema>;

/** The AI notes of a draft as stored: the entries in the order they were copied. */
export const storedAiNotesSchema = z.object({ entries: z.array(z.looseObject({ tokenId: z.string().min(1) })) });

export type StoredAiNotes = z.infer<typeof storedAiNotesSchema>;

export interface AiNotesAppendCall {
  readonly investigationId: string;
  /** The draft's version the caller read; a stale one is refused unless the token is already stored. */
  readonly expectedVersion: number;
  readonly entry: AiNotesEntryInput;
  /** The most references an entry may hold: the summary's element cap in force. */
  readonly maxRefs: number;
}

export interface AiNotesAppended {
  /** `already-stored` when an entry with the token id was there: nothing changed. */
  readonly outcome: 'appended' | 'already-stored';
  readonly version: number;
  readonly save: InvestigationSave;
}

export interface AiNotesRead {
  readonly entries: readonly Record<string, unknown>[];
  readonly version: number;
  readonly save: InvestigationSave;
}

/**
 * The AI notes of the caller's own drafts, given to the extension by the application so that the extension never reaches the database. Both calls refuse as the draft routes do: `NOT_FOUND` for an investigation
 * that is not the caller's, the read-only and source-changed refusals, `CONFLICTED_VIEW_VERSION` for a stale version, and `INVALID_REQUEST` with the reason `ai-notes-full` or `ai-notes-entry-too-large`.
 */
export interface AiNotesCapability {
  append(call: AiNotesAppendCall): Promise<AiNotesAppended>;
  /** Resolves when `append` would be allowed to write for the investigation, and rejects with the refusal it would give, without writing: the checks of a draft write, so a copy that has nothing to store is refused as one that has. */
  canWrite(investigationId: string): Promise<void>;
  read(investigationId: string): Promise<AiNotesRead>;
}

/** `GET /v1/investigations/{id}/draft/ai-notes?mask=…`: whether the viewer masks the personal data of the elements, as the rest of their view does. */
export const aiNotesQuerySchema = z.strictObject({ mask: z.enum(['true', 'false']) });

const text = z.string().min(1);

/** An element a rebuilt sentence cites, as the viewer is shown it. */
const aiNotesCitationSchema = z.strictObject({ kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]), title: z.string(), type: text });

const aiNotesSentenceSchema = z.strictObject({ text, citations: z.array(aiNotesCitationSchema) });

/** One stored summary rebuilt for the viewer: the label, the model, when it was made, the sentences the viewer may see and a coverage line built for them; never stored. */
const aiNotesEntrySchema = z.strictObject({ tokenId: text, label: z.literal('AI-drafted'), model: text, generatedAt: z.iso.datetime(), sentences: z.array(aiNotesSentenceSchema), coverage: text });

/** What the read answers: the entries in the order they were copied, and any entry that was not read, with a fixed reason. */
export const aiNotesResponseSchema = z.strictObject({ entries: z.array(aiNotesEntrySchema), skipped: z.array(z.strictObject({ tokenId: text, reason: z.enum(['too-large', 'unreadable']) })) });

export type AiNotesResponse = z.infer<typeof aiNotesResponseSchema>;
