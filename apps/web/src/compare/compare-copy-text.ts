import type { ColumnHeader } from './compare-elements.js';
import type { Row } from './compare-model.js';
import { DIFFERENCES_ONLY, FIRST_COLUMN } from './copy.js';

const flat = (text: string): string => text.replaceAll(/[\t\r\n]+/g, ' ');

/** One column as text: the title and caption, then `key: text` for each row shown, as drawn (a mask stays a mask); the first line says when only the differences are shown. */
export function columnText(header: ColumnHeader, index: number, rows: readonly Row[], differencesOnly: boolean): string {
  return [...(differencesOnly ? [DIFFERENCES_ONLY] : []), `${header.title} (${header.caption})`, ...rows.map((row) => `${row.label}: ${flat(row.cells[index]?.text ?? '')}`)].join('\n');
}

/** The table as tab-separated text a spreadsheet takes: a header row, then the rows shown; the first line says when only the differences are shown. */
export function tableText(headers: readonly ColumnHeader[], rows: readonly Row[], differencesOnly: boolean): string {
  return [...(differencesOnly ? [DIFFERENCES_ONLY] : []), [FIRST_COLUMN, ...headers.map((header) => flat(header.title))].join('\t'), ...rows.map((row) => [flat(row.label), ...row.cells.map((cell) => flat(cell.text))].join('\t'))].join('\n');
}
