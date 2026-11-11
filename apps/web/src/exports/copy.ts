import type { ExportFormat } from '@neburyx/contracts';

export const EXPORT_BUTTON = 'Export';
export const EXPORT_TITLE = 'Export current view';
export const FORMAT_LABEL = 'Format';
export const FORMAT_NAMES: Readonly<Record<ExportFormat, string>> = { json: 'JSON', csv: 'CSV' };
export const PREVIEW_HEADING = 'Every export starts with';
export const FOOTNOTE = 'Exports are partial views, not signed evidence.';
export const CANCEL = 'Cancel';
export const TRY_AGAIN = 'Try again';
export const CLOSE = 'Close';
export const PREPARING = 'Preparing…';
export const DONE_ANNOUNCEMENT = 'Export downloaded.';
export const NETWORK_FAILURE = 'The export could not be made. Try again.';
export const SCHEMA_FAILURE = 'The answer could not be read. Try again.';
export const EXPORT_BUSY = 'This export is already being made. Try again in a moment.';
export const EXPORT_DISABLED_SOURCE = 'Not available while the source has changed.';
export const ACCESS_NOTE = 'Some items may be hidden by your access.';

export const downloadLabel = (format: ExportFormat): string => `Download ${FORMAT_NAMES[format]}`;

export interface ExportLimits {
  readonly maxEntities: number;
  readonly maxRelationships: number;
  readonly maxAggregates: number;
}

const count = (value: number): string => value.toLocaleString('en-US');

/** The server's sentence for an export that is too large does not carry the numbers; the dialog adds them. */
export const tooLargeText = (message: string, limits: ExportLimits): string =>
  `${message} An export holds at most ${count(limits.maxEntities)} entities, ${count(limits.maxRelationships)} stored relationships and ${count(limits.maxAggregates)} aggregated relationships.`;

export const REFUSED_BANNER_ID = 'export-download-refused';
export const REFUSED_CHIP = 'Export';
export const REFUSED_HEADLINE = 'Your access changed since this export was made.';
export const REFUSED_TEXT = 'Export again to get a file that matches your current access.';
export const EXPORT_AGAIN = 'Export again';
