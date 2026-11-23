import { useState, type ReactNode } from "react";
import type { AssistantTable } from "@neburyx/contracts";
import type { CitationEntry } from "../summary/summary-model.js";
import { ASSISTANT_COPY, droppedRowsText, foldedRowsText, moreNotShownText, selectRowLabel, showSourceLabel } from "./copy.js";

const TABLE_FOLD_ABOVE = 10;
const TABLE_FOLD_HEAD = 3;

const NUMBER = /^[-+(]?\p{Sc}?\s?\d[\d,. ]*\s?[%\p{Sc}A-Za-z]{0,3}\)?$/u;
/** Whether every cell of a column is a number (with its sign, thousands separators, currency sign, percent or short unit): such a column is aligned right and its cells do not wrap. */
const STAMP = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s?(Z|[+-]\d{2}:?\d{2}|UTC)?)?$/;
/** Whether every cell of a column is a date or a time stamp: its cells do not wrap. */
const stampColumn = (rows: readonly { readonly cells: readonly string[] }[], column: number): boolean =>
  rows.length > 0 && rows.every((row) => STAMP.test((row.cells[column] ?? "").trim()));
const numericColumn = (rows: readonly { readonly cells: readonly string[] }[], column: number): boolean =>
  rows.length > 0 && rows.every((row) => NUMBER.test((row.cells[column] ?? "").trim()));

type CopyState = "idle" | "copied" | "failed";

export interface TableBlockProps {
  readonly table: AssistantTable;
  /** The markers of the elements a row cites, as the card draws markers. */
  readonly markersOf: (cites: readonly string[]) => ReactNode;
  /** The text of those markers, as the card draws them. */
  readonly markerTextOf: (cites: readonly string[]) => string;
  /** The entry of the first cited element of a row that has one. */
  readonly firstEntryOf: (cites: readonly string[]) => CitationEntry | undefined;
  readonly onSelectRow: (cites: readonly string[]) => void;
  /** Opens the Sources list at the source of an element; undefined where the card has no Sources list. */
  readonly onShowSource: ((entry: CitationEntry) => void) | undefined;
}

/** The text of the cells a table shows, one line a row, cells separated by a tab, the header first. */
function tableText(columns: readonly string[], rows: readonly { readonly cells: readonly string[]; readonly source: string }[], sourceLabel: string): string {
  return [[...columns, sourceLabel].join("\t"), ...rows.map((row) => [...row.cells, row.source].join("\t"))].join("\n");
}

/** One table block of an answer: its caption row with Copy table, the header and rows with a Source cell, its notices and its note. Folds and copies on its own. */
export function TableBlock({ table, markersOf, markerTextOf, firstEntryOf, onSelectRow, onShowSource }: TableBlockProps) {
  const [unfolded, setUnfolded] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const numeric = table.columns.map((_, column) => numericColumn(table.rows, column));
  const stamped = table.columns.map((_, column) => stampColumn(table.rows, column));
  const classOf = (column: number): string | undefined => (numeric[column] ? "assistant-table-number" : stamped[column] ? "assistant-table-stamp" : undefined);
  const longTable = table.rows.length > TABLE_FOLD_ABOVE;
  const folds = longTable && !unfolded;
  const rows = table.rows.map((row, index) => ({ row, index }));
  const visible = folds ? [...rows.slice(0, TABLE_FOLD_HEAD), ...rows.slice(-1)] : rows;
  const foldedCount = table.rows.length - TABLE_FOLD_HEAD - 1;
  const copyTable = (): void => {
    const text = tableText(table.columns, visible.map(({ row }) => ({ cells: row.cells, source: markerTextOf(row.cites) })), ASSISTANT_COPY.citeColumn);
    const written = typeof navigator === "undefined" || navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(text);
    written.then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };
  const foldRow = (
    <tr key="fold" className="assistant-table-fold">
      <td colSpan={table.columns.length + 1}>
        <button type="button" className="assistant-table-fold-button" aria-expanded={!folds} onClick={() => setUnfolded(!unfolded)}>
          {folds ? foldedRowsText(foldedCount) : ASSISTANT_COPY.foldClose}
        </button>
      </td>
    </tr>
  );
  const body = visible.flatMap((entry, position) => {
    const first = firstEntryOf(entry.row.cites);
    const line = (
      <tr
        key={entry.index}
        className="assistant-table-row"
        onClick={(event) => {
          if (!(event.target instanceof Element) || event.target.closest("button") === null) onSelectRow(entry.row.cites);
        }}
      >
        {entry.row.cells.map((cell, column) => (
          <td key={column} className={classOf(column)}>{cell}</td>
        ))}
        <td className="assistant-table-cite">
          <span className="summary-chips">{markersOf(entry.row.cites)}</span>
          {onShowSource === undefined || first === undefined ? null : (
            <button type="button" className="assistant-table-source-link" aria-label={showSourceLabel(first.number)} onClick={() => onShowSource(first)}>
              <span aria-hidden="true" className="icon icon-arrow-up-right" />
            </button>
          )}
          <button type="button" className="assistant-row-select" aria-label={selectRowLabel(entry.index + 1)} onClick={() => onSelectRow(entry.row.cites)}>
            <span aria-hidden="true">·</span>
          </button>
        </td>
      </tr>
    );
    return longTable && position === TABLE_FOLD_HEAD - 1 ? [line, foldRow] : [line];
  });
  return (
    <div className="assistant-table-block">
      <div className="assistant-table-head">
        <p className="assistant-table-title">{table.title}</p>
        <button type="button" className="assistant-table-copy" onClick={copyTable} onBlur={() => setCopy("idle")}>
          <span aria-hidden="true" className="icon icon-copy" />
          <span>{copy === "copied" ? ASSISTANT_COPY.tableCopied : ASSISTANT_COPY.copyTable}</span>
        </button>
        <span className="visually-hidden" role="status">{copy === "copied" ? ASSISTANT_COPY.tableCopied : copy === "failed" ? ASSISTANT_COPY.tableCopyFailed : ""}</span>
      </div>
      {copy === "failed" ? <p className="assistant-table-notice" role="note">{ASSISTANT_COPY.tableCopyFailed}</p> : null}
      <div className="assistant-table-scroll">
        <table className="assistant-table">
          <caption className="visually-hidden">{table.title}</caption>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} scope="col" className={classOf(index)}>{column}</th>
              ))}
              <th scope="col">{ASSISTANT_COPY.citeColumn}</th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {table.moreNotShown === undefined ? null : (
        <div className="assistant-table-notice" role="note">
          <strong>{ASSISTANT_COPY.moreNotShownTitle}</strong>
          <p>{moreNotShownText(table.rows.length, table.moreNotShown)}</p>
        </div>
      )}
      {table.droppedRows === undefined ? null : <p className="assistant-table-notice" role="note">{droppedRowsText(table.droppedRows)}</p>}
      <p className="assistant-table-footnote">{table.note}</p>
    </div>
  );
}
