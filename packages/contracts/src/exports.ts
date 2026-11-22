import { z } from 'zod';
import { aggregateEdgeRefSchema, derivedEdgeRefSchema } from './edge-detail.js';
import { exportSummarySchema } from './summary.js';
import { countSchema, edgeSchema, elementRefSchema, nodeSchema, storedEdgeRefSchema, type GraphEdge, type GraphNode } from './graph.js';

export const EXPORT_FORMATS = ['json', 'csv'] as const;
/** What a request may ask for: the two files the server stores, and the picture the browser draws. */
const EXPORT_REQUEST_FORMATS = [...EXPORT_FORMATS, 'png'] as const;
export const EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;

/** The key a client sends in `Idempotency-Key`: 16 to 64 letters, digits, `_` and `-` (`docs/api-conventions.md`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The one scope every export states about itself. */
export const EXPORT_SCOPE = 'current view (partial)';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const two = (value: number): string => String(value).padStart(2, '0');

/** The line of a header that states when the export was made, in UTC: `exported time: 30 Oct 2026, 10:18:24 UTC`. */
export function exportedTimeLine(at: Date): string {
  return `exported time: ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} UTC`;
}

/** The longest sealed summary token an export request may carry. */
const SUMMARY_TOKEN_MAX_LENGTH = 32_768;

/** The sentence a file carries when it leaves out something the person may not export; it never says how many or which. */
export const EXPORT_HIDDEN_NOTE = 'Some items may be hidden by your access.';

/**
 * `POST /v1/investigations/{id}/exports`: the references the person is showing. The server reads each through the gate and never uses the browser's copy. The size of what an export may hold is
 * checked by the server against its three limits (entities, stored relationships, aggregated or derived relationships) and answered with `INVALID_REQUEST` and the reason `export-too-large`.
 */
export const exportRequestSchema = z.strictObject({
  kind: z.literal('view'),
  format: z.enum(EXPORT_REQUEST_FORMATS),
  entities: z.array(elementRefSchema).default([]),
  edges: z.array(storedEdgeRefSchema).default([]),
  aggregates: z.array(aggregateEdgeRefSchema).default([]),
  derived: z.array(derivedEdgeRefSchema).default([]),
  /** Masks the fields marked `pii` in the file or the picture; absent means `false`. A policy can mask more, never less. */
  mask: z.boolean().optional(),
  /** The sealed token of the person's AI case summary, to include it in a JSON or a CSV file; a picture takes none. Without it no export carries any summary. */
  summaryToken: z.string().min(1).max(SUMMARY_TOKEN_MAX_LENGTH).optional(),
})
  .refine((request) => request.summaryToken === undefined || request.format !== 'png', { message: 'a picture takes no summary', path: ['summaryToken'] });

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

/** What the header says about masking: `off` (not asked for and nothing masked), or how many distinct fields in the file are masked, which is zero when masking was asked for and nothing needed it. */
export const exportMaskingSchema = z.union([z.literal('off'), z.strictObject({ maskedFields: z.number().int().nonnegative() })]);

export const exportHeaderSchema = z.strictObject({
  source: z.string().min(1),
  exported: z.string().min(1),
  scope: z.literal(EXPORT_SCOPE),
  coverage: z.strictObject({ shown: z.number().int().nonnegative(), notRetrieved: countSchema, uncounted: z.number().int().nonnegative() }),
  masking: exportMaskingSchema,
  /** The same lines as text, as the dialog previews them. */
  lines: z.array(z.string().min(1)).min(5),
});

/** The answer for a picture: the server reads and audits, the browser draws, so there is no stored file and no id. */
export const pngExportSchema = z.strictObject({
  format: z.literal('png'),
  filename: z.string().min(1),
  header: exportHeaderSchema,
});

/** The answer of `POST /v1/investigations/{id}/exports`: a stored file's record, or a picture's header. */
export const createExportResponseSchema = z.union([exportSchema, pngExportSchema]);

/** The JSON file: the header first, then what was read. */
export const exportFileSchema = z.strictObject({
  header: exportHeaderSchema,
  entities: z.array(nodeSchema),
  relationships: z.array(edgeSchema),
  /** Present only when the person included their AI case summary. */
  summary: exportSummarySchema.optional(),
});

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type PngExport = z.infer<typeof pngExportSchema>;
export type CreateExportResponse = z.infer<typeof createExportResponseSchema>;
export type ExportRecord = z.infer<typeof exportSchema>;
export type ExportHeader = z.infer<typeof exportHeaderSchema>;
export type ExportFile = z.infer<typeof exportFileSchema>;

/** How many distinct fields are masked in what was read: a field is the key of a masked property on an entity type or on a relationship type, however many items carry it. */
export function maskedFieldCountOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number {
  const fields = new Set<string>();
  for (const node of nodes) for (const property of node.properties) if (property.masked) fields.add(`entity\u0000${node.display.type}\u0000${property.key}`);
  for (const edge of edges) for (const property of edge.properties) if (property.masked) fields.add(`relationship\u0000${edge.type}\u0000${property.key}`);
  return fields.size;
}
