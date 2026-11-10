export type ExportFormat = 'json' | 'csv';

const EXTENSION: Readonly<Record<ExportFormat, string>> = { json: 'json', csv: 'zip' };

/** `neburyx-export-20261110T101500Z.json`: the time is the only variable part, so a name never holds a title, a source or an identifier. */
export function exportFilename(format: ExportFormat, exportedAt: Date): string {
  const stamp = exportedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `neburyx-export-${stamp}.${EXTENSION[format]}`;
}

export function contentTypeOf(format: ExportFormat): string {
  return format === 'json' ? 'application/json' : 'application/zip';
}
