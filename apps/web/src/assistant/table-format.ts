type Rows = readonly { readonly cells: readonly string[] }[];

const NUMBER = /^[-+(]?\p{Sc}?\s?\d[\d,. ]*\s?[%\p{Sc}A-Za-z]{0,3}\)?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s?(Z|UTC|\+00:?00)?$/;
const PLAIN_DECIMAL = /^(-?)([1-9]\d*|0)\.(\d+)$/;

export type ColumnKind = "number" | "stamp" | "text";

/** A time stamp as the table shows it, "YYYY-MM-DD HH:MM:SS", and whether it said that it is UTC; undefined for a cell that is not a time stamp. */
export function instantOf(cell: string): { readonly text: string; readonly utc: boolean } | undefined {
  const match = INSTANT.exec(cell.trim());
  return match === null ? undefined : { text: `${match[1]} ${match[2]}`, utc: match[3] !== undefined };
}

/**
 * A number as the table shows it: a decimal number written with no thousands separator gets them ("1664.72" is "1,664.72").
 * A whole number, a number that already has separators and a number with a leading zero (an identifier, not a figure) are shown as read, and so is anything else; decimal places are never changed.
 */
export function groupedNumber(cell: string): string {
  const match = PLAIN_DECIMAL.exec(cell.trim());
  if (match === null) return cell;
  return `${match[1]}${(match[2] ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${match[3]}`;
}

/** What each column holds: numbers, dates or time stamps, or text; a column is one of the first two only when every cell of it is. */
export function columnKinds(columns: readonly string[], rows: Rows): readonly ColumnKind[] {
  return columns.map((_, column) => {
    const cells = rows.map((row) => (row.cells[column] ?? "").trim());
    if (cells.length === 0) return "text";
    if (cells.every((cell) => DATE.test(cell) || INSTANT.test(cell))) return "stamp";
    return cells.every((cell) => NUMBER.test(cell)) ? "number" : "text";
  });
}

/** The header of a column of time stamps that all say UTC names it: "(UTC)" is added unless the header already says so. */
export function headerOf(column: string, kind: ColumnKind, rows: Rows, index: number): string {
  if (kind !== "stamp" || /\(UTC\)/i.test(column)) return column;
  const instants = rows.map((row) => instantOf(row.cells[index] ?? ""));
  return instants.length > 0 && instants.every((instant) => instant?.utc === true) ? `${column} (UTC)` : column;
}

/** The text of a cell as the table shows it; the copy of the table keeps the cell as read. */
export function cellOf(cell: string, kind: ColumnKind): string {
  if (kind === "number") return groupedNumber(cell);
  if (kind === "stamp") return instantOf(cell)?.text ?? cell;
  return cell;
}
