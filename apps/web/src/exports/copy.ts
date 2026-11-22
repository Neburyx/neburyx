import type { ExportFormat } from '@neburyx/contracts';

export const EXPORT_BUTTON = 'Export';
export const EXPORT_TITLE = 'Export current view';
export const FORMAT_LABEL = 'Format';
export type PictureFormat = ExportFormat | 'png';
export const FORMAT_NAMES: Readonly<Record<PictureFormat, string>> = { json: 'JSON', csv: 'CSV', png: 'PNG' };
export const PREVIEW_HEADING = 'Every export starts with';
export const FILE_MASKED_LINE = 'masking: on · the header states how many fields are masked';
export const PICTURE_MASKED_LINE = 'masking: on · the picture states how many fields are masked';
export const FOOTNOTE = 'Exports are partial views, not signed evidence.';
export const CANCEL = 'Cancel';
export const TRY_AGAIN = 'Try again';
export const PREPARING = 'Preparing…';
export const DONE_ANNOUNCEMENT = 'Export downloaded.';
export const PICTURE_FAILURE = 'The export could not be made. Try again.';
export const NETWORK_FAILURE = 'The export could not be made. Try again.';
export const SCHEMA_FAILURE = 'The answer could not be read. Try again.';
export const EXPORT_BUSY = 'This export is already being made. Try again in a moment.';
export const EXPORT_DISABLED_SOURCE = 'Not available while the source has changed.';

export const INCLUDE_SUMMARY = 'Include AI case summary';
export const SUMMARY_NO_DRAFT = 'Draft a summary first';
export const SUMMARY_EXPIRED = 'The draft has expired';
export const SUMMARY_EDITED = "Edited text can't be exported with the summary";
export const SUMMARY_NOT_FOR_PICTURE = 'Not for a picture';
export const SUMMARY_REFUSED = 'The summary could not be included, so nothing was exported. You can export without it.';

export const downloadLabel = (format: PictureFormat, masked = false): string => `Download ${FORMAT_NAMES[format]}${masked ? ' (masked)' : ''}`;

export const MASK_BUTTON = 'Mask critical fields';
export const maskHint = (names: readonly string[] | undefined): string => `Hides fields marked pii in neburyx.yaml${names === undefined || names.length === 0 ? '' : ` (${names.join(', ')})`}. Enterprise: fields your policy masks stay masked.`;
export const MASK_OFF_STATE = 'Off · exports include all values';
export const MASK_LOCKED_BY_SWITCH = 'Locked on while the view is masked';
export const MASK_LOCKED_BY_POLICY = 'Locked on by your policy';
export const maskOnState = (fields: number | undefined): string => (fields === undefined ? 'On' : `On · ${fields} ${fields === 1 ? 'field' : 'fields'} marked pii in this view`);

export interface ExportLimits {
  readonly maxEntities: number;
  readonly maxRelationships: number;
  readonly maxAggregates: number;
}

const count = (value: number): string => value.toLocaleString('en-US');

/** The server's sentence for an export that is too large does not carry the numbers; the dialog adds them. */
export const tooLargeText = (message: string, limits: ExportLimits): string =>
  `${message} An export holds at most ${count(limits.maxEntities)} entities, ${count(limits.maxRelationships)} stored relationships and ${count(limits.maxAggregates)} aggregated or derived relationships.`;

export const REFUSED_BANNER_ID = 'export-download-refused';
export const REFUSED_CHIP = 'Export';
export const REFUSED_HEADLINE = 'Your access changed since this export was made.';
export const REFUSED_TEXT = 'Export again to get a file that matches your current access.';
export const SOURCE_REFUSED_HEADLINE = 'The source of this export changed since it was made.';
export const SOURCE_REFUSED_TEXT = 'The file is no longer available.';
export const EXPORT_AGAIN = 'Export again';
