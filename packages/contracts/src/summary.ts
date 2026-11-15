import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import { elementRefSchema, storedEdgeRefSchema } from './graph.js';
import type { ReadRefsResponse } from './read-refs.js';
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

export const summarySentenceSchema = z.strictObject({ text: text, cites: z.array(text) });

export type SummarySentence = z.infer<typeof summarySentenceSchema>;

const callCount = z.number().int().nonnegative();

export const summaryResponseSchema = z.union([
  z.strictObject({ status: z.literal('ok'), sentences: z.array(summarySentenceSchema), sent: z.string(), model: text, calls: callCount.min(1), summaryToken: text }),
  z.strictObject({ status: z.literal('tooLarge'), limit: z.literal('elements'), elements: z.number().int().nonnegative(), cap: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('tooLarge'), limit: z.literal('text'), estimatedTokens: z.number().int().nonnegative(), cap: z.number().int().positive() }),
  z.strictObject({ status: z.literal('timeLimit'), calls: callCount }),
  z.strictObject({ status: z.literal('failed'), kind: z.enum(SUMMARY_FAILURE_KINDS), calls: callCount }),
]);

export type SummaryResponse = z.infer<typeof summaryResponseSchema>;

export type CaseSummaryAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface CaseSummaryInput {
  readonly actorId: string;
  readonly actorRole: z.infer<typeof roleSchema>;
  readonly traceId: string;
  /** The caller's policy version for the source of the request, as the application holds it. */
  readonly policyVersion: string;
  readonly request: SummaryRequest;
  /** What the gate returned for the references of the request, read again for this person. */
  readonly reading: ReadRefsResponse;
}

export type CaseSummaryOutcome = SummaryResponse;

/** The seam the case summary runs through: the Community default says it is not available; an installed one drafts the summary of a request, or says why it could not. */
export interface CaseSummarizer {
  /** The most elements a request may name; a request over it is `tooLarge` before anything is read. */
  readonly maxElements: number;
  availability(): CaseSummaryAvailability;
  summarize(input: CaseSummaryInput, signal: AbortSignal): Promise<CaseSummaryOutcome>;
}
