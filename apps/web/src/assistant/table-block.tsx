import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AssistantTable } from "@neburyx/contracts";
import type { CitationEntry } from "../summary/summary-model.js";
import { cellOf, columnKinds, headerOf } from "./table-format.js";
import { ASSISTANT_COPY, droppedRowsText, foldedRowsText, moreNotShownText, selectRowLabel, showSourceLabel } from "./copy.js";
import { cuts, textWidthOf } from "./cut-text.js";

const TABLE_FOLD_ABOVE = 10;
const TABLE_FOLD_HEAD = 3;
/** The room a tip needs under a cell, in pixels, before it is drawn above the cell. */
const TIP_ROOM = 80;
/** The gap between a cell and its tip, in pixels. */
const TIP_GAP = 4;
/** What the title column keeps beside its widest value, in pixels: the text is measured by its fractional width, and a pixel more is room for what layout rounds up. */
const TITLE_SLACK = 1;
/** How long a tip stays after the pointer leaves its cell, so that the pointer can move onto it. */
const TIP_LINGER_MS = 150;

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

/** The full text of a cell that is cut, drawn as a tip under it: where it is, in the window. */
interface CellTip {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly above: boolean;
  /** Whether the keyboard focus opened it: only then does Esc belong to it. */
  readonly byFocus: boolean;
}

/** The tip of the cut cell inside a table cell, if the cell cuts its text. */
function tipOf(cell: Element | null, byFocus = false): CellTip | undefined {
  const clip = cell?.querySelector<HTMLElement>(".assistant-table-clip");
  if (cell === null || clip === null || clip === undefined || !cuts(clip)) return undefined;
  const box = cell.getBoundingClientRect();
  const above = box.bottom + TIP_ROOM > window.innerHeight;
  return { text: clip.textContent ?? "", left: box.left, top: above ? box.top - TIP_GAP : box.bottom + TIP_GAP, above, byFocus };
}

/** The tip of a row that has the keyboard focus: the full text of its cut cells (with the column of each when there are several), under the first of them. */
function rowTipOf(row: Element, columns: readonly string[]): CellTip | undefined {
  const cut = [...row.querySelectorAll("td")].flatMap((cell, column) => {
    const tip = tipOf(cell, true);
    return tip === undefined ? [] : [{ tip, label: columns[column] ?? "" }];
  });
  const first = cut[0];
  if (first === undefined) return undefined;
  return { ...first.tip, text: cut.length === 1 ? first.tip.text : cut.map((entry) => `${entry.label}: ${entry.tip.text}`).join("\n") };
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
  const [squeezed, setSqueezed] = useState(false);
  const [tip, setTip] = useState<CellTip | undefined>(undefined);
  const lingering = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showTip = (next: CellTip | undefined): void => {
    clearTimeout(lingering.current);
    setTip(next);
  };
  const hideTipSoon = (): void => {
    clearTimeout(lingering.current);
    lingering.current = setTimeout(() => setTip(undefined), TIP_LINGER_MS);
  };
  useEffect(() => () => clearTimeout(lingering.current), []);
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return undefined;
    const measure = (): void => {
      // the fold line is centred in the frame the person sees, wherever the table is scrolled to
      element.style.setProperty("--assistant-table-frame", `${element.clientWidth}px`);
      setScrollsOn(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
      // the title column keeps its content width until the table overflows with every cell at its cap: only then does it give way (with its ellipsis) down to a floor; measured without the squeeze, so that a wider panel lets it go
      element.classList.remove("assistant-table-squeezed");
      const head = element.querySelector<HTMLElement>("th.assistant-table-title-cell");
      if (head !== null) {
        // the floor of the title column is a width of its text: that of its widest value or label, without the padding the column keeps besides
        const style = getComputedStyle(head);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        let widest = textWidthOf(head);
        for (const clip of element.querySelectorAll<HTMLElement>("td.assistant-table-title-cell .assistant-table-clip")) widest = Math.max(widest, textWidthOf(clip));
        element.style.setProperty("--assistant-table-title-pad", `${padding}px`);
        element.style.setProperty("--assistant-table-title-natural", `${Math.ceil(widest) + TITLE_SLACK}px`);
      }
      const naturalOverflow = element.scrollWidth > element.clientWidth;
      if (naturalOverflow) element.classList.add("assistant-table-squeezed");
      setSqueezed(naturalOverflow);
    };
    measure();
    const onScroll = (): void => {
      setScrollsOn(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
      setTip(undefined);
    };
    element.addEventListener("scroll", onScroll);
    // a tip is placed for the layout it was drawn in: a change of width takes it away
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        setTip(undefined);
      }
      measure();
    });
    observer?.observe(element);
    // the widths measured are those of the fallback face until the fonts of the page are loaded
    let gone = false;
    if (typeof document !== "undefined" && document.fonts !== undefined) void document.fonts.ready.then(() => { if (!gone) measure(); });
    return () => {
      gone = true;
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [table, unfolded, squeezed]);
  useEffect(() => {
    if (tip === undefined) return undefined;
    const hide = (): void => setTip(undefined);
    // Esc takes the tip away and goes no further, as on the copy buttons
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // a tip the pointer opened does not take the key from what the person is doing; one the keyboard opened does
      if (tip.byFocus) event.stopPropagation();
      hide();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [tip]);
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
        <div className="assistant-table-fold-frame">
          <button type="button" className="assistant-table-fold-button" aria-expanded={!folds} onClick={() => setUnfolded(!unfolded)}>
            {folds ? foldedRowsText(foldedCount) : ASSISTANT_COPY.foldClose}
          </button>
        </div>
      </td>
    </tr>
  );
  const body = visible.flatMap((entry, position) => {
    const first = firstEntryOf(entry.row.cites);
    const line = (
      <tr
        key={entry.index}
        className="assistant-table-row"
        onFocus={(event) => showTip(event.target instanceof Element && event.target.matches(":focus-visible") ? rowTipOf(event.currentTarget, table.columns) : undefined)}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) showTip(undefined);
        }}
        onMouseOver={(event) => showTip(event.target instanceof Element ? tipOf(event.target.closest("td")) : undefined)}
        onMouseLeave={hideTipSoon}
        onClick={(event) => {
          if (!(event.target instanceof Element) || event.target.closest("button") === null) onSelectRow(entry.row.cites);
        }}
      >
        {entry.row.cells.map((cell, column) => (
          <td key={column} className={classOf(column)}>
            {kinds[column] === "text" ? <span className="assistant-table-clip">{cell}</span> : cellOf(cell, kinds[column] ?? "text", table.rows, column)}
          </td>
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
          <span>{copy === "copied" ? ASSISTANT_COPY.tableCopied : ASSISTANT_COPY.copyTable}</span>
        </button>
        <span className="visually-hidden" role="status">{copy === "copied" ? ASSISTANT_COPY.tableCopied : copy === "failed" ? ASSISTANT_COPY.tableCopyFailed : ""}</span>
      </div>
      {copy === "failed" ? <p className="assistant-table-notice" role="note">{ASSISTANT_COPY.tableCopyFailed}</p> : null}
      <div ref={scroller} className={`assistant-table-scroll${scrollsOn ? " assistant-table-scrolls" : ""}${squeezed ? " assistant-table-squeezed" : ""}`}>
        <table className="assistant-table">
          <caption className="visually-hidden">{table.title}</caption>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} scope="col" className={classOf(index)} title={headerOf(column, kinds[index] ?? "text", table.rows, index)}>{headerOf(column, kinds[index] ?? "text", table.rows, index)}</th>
              ))}
              <th scope="col">{ASSISTANT_COPY.citeColumn}</th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {tip === undefined || typeof document === "undefined"
        ? null
        : createPortal(
            <div className={`assistant-table-tip${tip.above ? " assistant-table-tip-above" : ""}`} style={{ left: tip.left, top: tip.top }} aria-hidden="true" onMouseEnter={() => clearTimeout(lingering.current)} onMouseLeave={hideTipSoon}>
              {tip.text}
            </div>,
            document.body,
          )}
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
