import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema, storedEdgeRefSchema } from './graph.js';

export const EXPORT_FORMATS = ['json', 'csv'] as const;
export const EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;

/** The key a client sends in `Idempotency-Key`: 16 to 64 letters, digits, `_` and `-` (`docs/api-conventions.md`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The one scope every export states about itself. */
export const EXPORT_SCOPE = 'current view (partial)';

/** The sentence a file carries when it leaves out something the person may not export; it never says how many or which. */
export const EXPORT_HIDDEN_NOTE = 'Some items may be hidden by your access.';

/**
 * `POST /v1/investigations/{id}/exports`: the references the person is showing. The server reads each through the gate and never uses the browser's copy. The size of what an export may hold is
 * checked by the server against its three limits (entities, stored relationships, aggregated or derived relationships) and answered with `INVALID_REQUEST` and the reason `export-too-large`.
 */
export const exportRequestSchema = z.strictObject({
  kind: z.literal('view'),
  format: z.enum(EXPORT_FORMATS),
  entities: z.array(elementRefSchema).default([]),
  edges: z.array(storedEdgeRefSchema).default([]),
  aggregates: z.array(aggregateEdgeRefSchema).default([]),
  derived: z.array(derivedEdgeRefSchema).default([]),
});

/** An export as a client sees it: never its storage key or hash. */
export const exportSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(EXPORT_STATUSES),
  format: z.enum(EXPORT_FORMATS),
  filename: z.string().min(1).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

/** What the header says about masking: `off`, or how many distinct fields in the file are masked. */
export const exportMaskingSchema = z.union([z.literal('off'), z.strictObject({ maskedFields: z.number().int().positive() })]);

export const exportHeaderSchema = z.strictObject({
  source: z.string().min(1),
  exported: z.string().min(1),
  scope: z.literal(EXPORT_SCOPE),
  coverage: z.strictObject({ shown: z.number().int().nonnegative(), notRetrieved: countSchema, uncounted: z.number().int().nonnegative() }),
  masking: exportMaskingSchema,
  /** The same lines as text, as the dialog previews them. */
  lines: z.array(z.string().min(1)).min(5),
});

/** The JSON file: the header first, then what was read. */
export const exportFileSchema = z.strictObject({
  header: exportHeaderSchema,
  entities: z.array(nodeSchema),
  relationships: z.array(edgeSchema),
});

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type ExportRecord = z.infer<typeof exportSchema>;
export type ExportHeader = z.infer<typeof exportHeaderSchema>;
export type ExportFile = z.infer<typeof exportFileSchema>;
