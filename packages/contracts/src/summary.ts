import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import { storedEdgeRefSchema } from './graph.js';
import { countSchema, edgeRefSchema, edgeSchema, elementRefSchema, nodeSchema } from './graph.js';
import { investigationSaveSchema } from './investigations.js';
import type { roleSchema } from './me.js';

const text = z.string().min(1);

/** `POST /v1/summary`: the references of the elements in view, never their content; the server reads them again through the gate. Each list is bounded by the API's body limit and the operator's element cap. */
export const summaryRequestSchema = z.strictObject({
  investigationId: text,
  sourceId: text,
  mask: z.boolean().optional(),
  entities: z.array(elementRefSchema).default([]),
  edges: z.array(storedEdgeRefSchema).default([]),
  aggregates: z.array(aggregateEdgeRefSchema).default([]),
  derived: z.array(derivedEdgeRefSchema).default([]),
});

export type SummaryRequest = z.infer<typeof summaryRequestSchema>;

/** Why a draft could not be produced; the provider's own words are never carried. `format` is a reply that stayed unusable after every allowed call. */
export const SUMMARY_FAILURE_KINDS = ['format', 'timeout', 'unreachable', 'rate-limited', 'refused', 'truncated', 'rejected', 'provider-error', 'bad-reply'] as const;

export type SummaryFailureKind = (typeof SUMMARY_FAILURE_KINDS)[number];

/** What the re-read of a view gave: the elements the person may export, how many references did not resolve, whether elements were left out for the export right, and how many relationships are not yet retrieved. */
export const summaryReadingSchema = z.strictObject({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  unresolved: z.number().int().nonnegative(),
  omitted: z.boolean(),
  notRetrieved: countSchema,
  uncounted: z.number().int().nonnegative(),
});

export type SummaryReading = z.infer<typeof summaryReadingSchema>;

export const summarySentenceSchema = z.strictObject({ text: text, cites: z.array(text) });

export type SummarySentence = z.infer<typeof summarySentenceSchema>;

const callCount = z.number().int().nonnegative();

/** Why a sentence cannot be stored as AI notes, in three groups: a number or a date that no element of the sentence's citations gives; a name or a value that is not of an element the sentence cites; a word outside the fixed list. */
export const NOT_STORABLE_REASONS = ['number', 'value', 'word'] as const;

/** A sentence of a draft as the answer carries it: `storable` says whether Copy to notes will keep it, by the rule the copy itself applies, and `notStorable` says why not, for the panel to say. */
export const summaryResponseSentenceSchema = z.strictObject({ text: text, cites: z.array(text), storable: z.boolean(), notStorable: z.enum(NOT_STORABLE_REASONS).optional() });

const citationSchema = z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) });

/** What the server says the draft does not cover, in two parts: what the re-read left out (written as the export header writes it) and how much of what is shown the draft cites. */
const coverageSchema = z.strictObject({ retrieval: text, summary: text });

const draftFields = { sentences: z.array(summaryResponseSentenceSchema), citations: z.array(citationSchema), coverage: coverageSchema, removedCount: callCount, sent: z.string(), model: text, calls: callCount.min(1), summaryToken: text };

export const summaryResponseSchema = z.union([
  z.strictObject({ status: z.literal('ok'), ...draftFields }),
  z.strictObject({ status: z.literal('partial'), ...draftFields }),
  z.strictObject({ status: z.literal('unsupported'), removedCount: callCount, coverage: coverageSchema, sent: z.string(), model: text, calls: callCount.min(1) }),
  z.strictObject({ status: z.literal('tooLarge'), limit: z.literal('elements'), elements: z.number().int().nonnegative(), cap: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('tooLarge'), limit: z.literal('text'), estimatedTokens: z.number().int().nonnegative(), cap: z.number().int().positive() }),
  z.strictObject({ status: z.literal('timeLimit'), calls: callCount }),
  z.strictObject({ status: z.literal('failed'), kind: z.enum(SUMMARY_FAILURE_KINDS), calls: callCount }),
]);

export type SummaryResponse = z.infer<typeof summaryResponseSchema>;

export const copyToNotesParamsSchema = z.strictObject({ id: text });

/** `POST /v1/investigations/{id}/draft/ai-notes`: the token of a draft and the draft's version the caller read. */
export const copyToNotesRequestSchema = z.strictObject({ summaryToken: text, version: z.number().int().positive() });

export type CopyToNotesRequest = z.infer<typeof copyToNotesRequestSchema>;

/** How many sentences were kept and how many were not, whether the token had been copied before, and the draft's current version and save state, which only an append changes. */
export const copyToNotesResponseSchema = z.strictObject({ copied: callCount, notCopied: callCount, alreadyCopied: z.boolean(), version: z.number().int().positive(), save: investigationSaveSchema });

export type CopyToNotesResponse = z.infer<typeof copyToNotesResponseSchema>;

/** How long a summary token can be used, from the moment its draft was made: the server seals it for this long, and the client offers the export option for as long. */
export const SUMMARY_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

const EXPORT_SUMMARY_MAX_SENTENCES = 12;

/** The summary section of an export file: the label, the model, when it was drafted, the two parts of its coverage and the sentences that still hold, each with the elements it cites as they are in the same file. */
export const exportSummarySchema = z.strictObject({
  label: z.literal('AI-drafted'),
  model: text,
  generatedAt: z.iso.datetime(),
  coverage: z.strictObject({ retrieval: text, summary: text }),
  sentences: z.array(z.strictObject({ text, cites: z.array(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('entity'), ref: elementRefSchema }), z.strictObject({ kind: z.literal('relationship'), ref: edgeRefSchema })])).min(1) })).max(EXPORT_SUMMARY_MAX_SENTENCES),
});

export type ExportSummary = z.infer<typeof exportSummarySchema>;

/** What an export hands the summarizer: the token the person sent, the person and the policy version it must open under, and what the export's own read of the elements returned. */
export interface CaseSummaryExportInput {
  readonly token: string;
  readonly investigationId: string;
  readonly actorId: string;
  readonly policyVersion: string;
  readonly reading: SummaryReading;
}

/** The section to write, with the id of the run and how many sentences were kept and dropped; or the one refusal, which says nothing of why. */
export type CaseSummaryExportOutcome = { readonly status: 'ok'; readonly section: ExportSummary; readonly runId: string; readonly kept: number; readonly dropped: number } | { readonly status: 'refused' };

export type CaseSummaryAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface CaseSummaryInput {
  readonly actorId: string;
  readonly actorRole: z.infer<typeof roleSchema>;
  readonly traceId: string;
  /** The caller's policy version for the source of the request, as the application holds it. */
  readonly policyVersion: string;
  readonly request: SummaryRequest;
  /** What the gate returned for the references of the request, read again for this person. */
  readonly reading: SummaryReading;
  /** The most model calls this draft may make, when the caller has a limit of its own to keep (a turn of the assistant); the summarizer makes no more than the smaller of this and its own limit. */
  readonly maxCalls?: number;
  /** The time limit of the caller's own (a turn of the assistant): a draft that ends with it ends as `timeLimit`, not as a cancel by the client. */
  readonly deadline?: AbortSignal;
}

export type CaseSummaryOutcome = SummaryResponse;

/** The seam the case summary runs through: the Community default says it is not available; an installed one drafts the summary of a request, or says why it could not. */
export interface CaseSummarizer {
  /** The most elements a request may name; a request over it is `tooLarge` before anything is read. */
  readonly maxElements: number;
  availability(): CaseSummaryAvailability;
  summarize(input: CaseSummaryInput, signal: AbortSignal): Promise<CaseSummaryOutcome>;
  /**
   * Records a click that ended in the route before any call (too many elements, a failed read, a client that gave up): its run row and its closing event, named to each other. Rejects when the record cannot be written;
   * a summarizer that keeps no record has none.
   */
  recordEarlyEnd?(end: CaseSummaryEarlyEnd): Promise<void>;
  /** The summary section of an export for a token; absent in a summarizer that does not take part in exports, which an export treats as not available. Reads nothing: the export's own reading is passed in. */
  renderForExport?(input: CaseSummaryExportInput): CaseSummaryExportOutcome;
}

export interface CaseSummaryEarlyEnd {
  readonly actorId: string;
  readonly actorRole: z.infer<typeof roleSchema>;
  readonly traceId: string;
  readonly request: SummaryRequest;
  readonly outcome: 'tooLarge' | 'read-failed' | 'cancelled' | 'error' | 'unavailable';
}
