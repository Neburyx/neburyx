import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantTable } from "@neburyx/contracts";
import type { CitationEntry } from "../summary/summary-model.js";
import { cellOf, columnKinds, headerOf } from "./table-format.js";
import { ASSISTANT_COPY, droppedRowsText, foldedRowsText, moreNotShownText, selectRowLabel, showSourceLabel } from "./copy.js";

const TABLE_FOLD_ABOVE = 10;
const TABLE_FOLD_HEAD = 3;

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

/** A time stamp shown as date and time is two parts that never break inside, with the space between them the only place the stamp may break. */
function stampOf(text: string, kind: string | undefined): ReactNode {
  const match = kind === "stamp" ? /^(\d{4}-\d{2}-\d{2}) (\S.*)$/.exec(text) : null;
  if (match === null) return text;
  return (
    <>
      <span className="assistant-stamp-part">{match[1]}</span> <span className="assistant-stamp-part">{match[2]}</span>
    </>
  );
}

/** One table block of an answer: its caption row with Copy table, the header and rows with a Source cell, its notices and its note. Folds and copies on its own. */
export function TableBlock({ table, markersOf, markerTextOf, firstEntryOf, onSelectRow, onShowSource }: TableBlockProps) {
  const [unfolded, setUnfolded] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const kinds = columnKinds(table.columns, table.rows);
  /** The first column of text gives way when the table is too wide; with no column of text the table scrolls. */
  const titleColumn = kinds.indexOf("text");
  const classOf = (column: number): string | undefined => {
    const kind = kinds[column];
    return kind === "number" ? "assistant-table-number" : kind === "stamp" ? "assistant-table-stamp" : column === titleColumn ? "assistant-table-title-cell" : undefined;
  };
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollsOn, setScrollsOn] = useState(false);
  const [tight, setTight] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return undefined;
    const measure = (): void => {
      setScrollsOn(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
      // a table is tight when it overflows with its time stamps kept whole: measured without the breaks, so that a wider panel lets them go
      const wasTight = element.classList.contains("assistant-table-tight");
      element.classList.remove("assistant-table-tight");
      const overflows = element.scrollWidth > element.clientWidth;
      if (wasTight) element.classList.add("assistant-table-tight");
      setTight(overflows);
      // the full title of a row is drawn over its cell up to the Source column: how far that is from the cell
      const title = element.querySelector<HTMLElement>("th.assistant-table-title-cell");
      const source = element.querySelector<HTMLElement>("th:last-child");
      if (title !== null && source !== null) element.style.setProperty("--assistant-table-room", `${Math.max(0, element.clientWidth - source.offsetWidth - (title.offsetLeft - element.scrollLeft))}px`);
    };
    measure();
    element.addEventListener("scroll", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [table.rows.length, unfolded, tight]);
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
          column === titleColumn ? (
            <td key={column} className={classOf(column)} title={cell} data-full={cell}>
              <span className="assistant-table-title-clip">{cell}</span>
            </td>
          ) : (
            <td key={column} className={classOf(column)}>{stampOf(cellOf(cell, kinds[column] ?? "text", table.rows, column), kinds[column])}</td>
          )
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
        {table.title === "" ? <span /> : <p className="assistant-table-title">{table.title}</p>}
        <button type="button" className="assistant-table-copy" onClick={copyTable} onBlur={() => setCopy("idle")}>
          <span aria-hidden="true" className="icon icon-copy" />
          <span>{copy === "copied" ? ASSISTANT_COPY.tableCopied : ASSISTANT_COPY.copyTable}</span>
        </button>
        <span className="visually-hidden" role="status">{copy === "copied" ? ASSISTANT_COPY.tableCopied : copy === "failed" ? ASSISTANT_COPY.tableCopyFailed : ""}</span>
      </div>
      {copy === "failed" ? <p className="assistant-table-notice" role="note">{ASSISTANT_COPY.tableCopyFailed}</p> : null}
      <div ref={scroller} className={`assistant-table-scroll${scrollsOn ? " assistant-table-scrolls" : ""}${tight ? " assistant-table-tight" : ""}`}>
        <table className="assistant-table">
          <caption className="visually-hidden">{table.title}</caption>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} scope="col" className={classOf(index)}>{headerOf(column, kinds[index] ?? "text", table.rows, index)}</th>
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
      {table.note === "" ? null : <p className="assistant-table-footnote">{table.note}</p>}
    </div>
  );
}
