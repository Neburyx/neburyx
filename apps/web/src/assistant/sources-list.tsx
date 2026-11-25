import { useEffect, useRef, useState } from "react";
import type { CitationEntry } from "../summary/summary-model.js";
import { ASSISTANT_COPY, GROUP_MEMBERS_SHOWN, moreInGroupText, pageSourcesText, sourcesGroupedText, sourcesText } from "./copy.js";
import type { RowState } from "./row-state.js";
import { groupSources, type SourceRow } from "./source-groups.js";

export function SourcesList({
  entries,
  labelOf,
  statusOf,
  isSelectable,
  rowStateOf,
  onPress,
  focusRequest,
  onFocusHandled,
}: {
  readonly entries: readonly CitationEntry[];
  readonly labelOf: (entry: CitationEntry) => string;
  readonly statusOf: (entry: CitationEntry) => string;
  readonly isSelectable: (entry: CitationEntry) => boolean;
  /** On the page: the state a row shows beside its label and the notice under it. */
  readonly rowStateOf?: (entry: CitationEntry) => RowState | undefined;
  readonly onPress: (entry: CitationEntry) => void;
  readonly focusRequest: { readonly number: number; readonly tick: number } | undefined;
  readonly onFocusHandled: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allShown, setAllShown] = useState<ReadonlySet<string>>(new Set());
  const focusAfterShowAll = useRef<string | undefined>(undefined);
  const rows = groupSources(entries);
  const lines = useRef(new Map<number, HTMLButtonElement>());
  const items = useRef(new Map<number, HTMLLIElement>());
  /** The number the list was asked to show: its row (or the line of its group) is marked, besides having the focus, so that a pointer user sees where it is too. */
  const [marked, setMarked] = useState<number | undefined>(undefined);
  const target = focusRequest?.number;
  useEffect(() => {
    if (target === undefined) return;
    lines.current.get(target)?.focus();
    setMarked(target);
    onFocusHandled();
  }, [target, focusRequest?.tick, onFocusHandled]);
  const hasGroup = rows.some((row) => row.kind === "group");
  /** The row the page has just given a state (pressed, highlighted, selected, not on the canvas) is brought whole into view, notice included, and only as far as it takes: where it is whole already nothing moves. */
  const stated = rowStateOf === undefined ? undefined : entries.find((entry) => {
    const kind = rowStateOf(entry)?.kind;
    return kind !== undefined && kind !== "idle" && kind !== "pending";
  });
  const statedNumber = stated?.number;
  const statedKind = stated === undefined ? undefined : rowStateOf?.(stated)?.kind;
  useEffect(() => {
    if (statedNumber === undefined) return;
    const item = items.current.get(statedNumber);
    if (item !== undefined && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [statedNumber, statedKind]);
  const flip = (held: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(held);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const rowOf = (entry: CitationEntry, nested: boolean) => {
    const rowState = rowStateOf?.(entry);
    return (
    <li key={entry.key} className={nested ? "assistant-source-member" : undefined} ref={(item) => {
      if (item === null) items.current.delete(entry.number);
      else items.current.set(entry.number, item);
    }}>
      <button
        type="button"
        className="assistant-source-row"
        data-marked={marked === entry.number ? "" : undefined}
        onBlur={() => setMarked(undefined)}
        ref={(button) => {
          if (button !== null && !nested) lines.current.set(entry.number, button);
          if (button === null || focusAfterShowAll.current !== entry.key) return;
          focusAfterShowAll.current = undefined;
          button.focus();
        }}
        title={rowState === undefined ? statusOf(entry) : rowState.text}
        data-selection={rowState === undefined || rowState.kind === "idle" ? undefined : rowState.kind}
        aria-label={`${ASSISTANT_COPY.sources}: ${entry.number}, ${labelOf(entry)}. ${rowState === undefined ? statusOf(entry) : rowState.text}`}
        onClick={() => onPress(entry)}
      >
        <span className="summary-chip assistant-marker" aria-hidden="true">[{entry.number}]</span>
        <span className="assistant-source-label">
          {labelOf(entry)}
          {isSelectable(entry) || rowState !== undefined ? null : <span className="summary-chip-note">{statusOf(entry)}</span>}
        </span>
        {rowState === undefined ? null : <span className="assistant-source-state" data-selection={rowState.kind}>{rowState.text}</span>}
      </button>
      {rowState === undefined || (rowState.notice === undefined && rowState.openGraph === undefined) ? null : (
        <div className="assistant-source-notice" role="status">
          {rowState.notice === undefined ? null : <span>{rowState.notice}</span>}
          {rowState.openGraph === undefined ? null : (
            <button type="button" className="assistant-source-open" onClick={rowState.openGraph}>
              <span className="icon icon-arrow-up-right" aria-hidden="true" />
              {ASSISTANT_COPY.openGraph}
            </button>
          )}
        </div>
      )}
    </li>
    );
  };
  const groupOf = (row: Extract<SourceRow, { kind: "group" }>) => {
    const open = expanded.has(row.id);
    const shown = allShown.has(row.id) ? row.members : row.members.slice(0, GROUP_MEMBERS_SHOWN);
    const rest = row.members.length - shown.length;
    return (
      <li key={row.id} className="assistant-source-group">
        <button
          type="button"
          className="assistant-source-row assistant-group-line"
          data-marked={marked !== undefined && row.members.some((member) => member.number === marked) ? "" : undefined}
          onBlur={() => setMarked(undefined)}
          ref={(button) => {
            if (button !== null) for (const member of row.members) lines.current.set(member.number, button);
          }}
          aria-expanded={open}
          aria-label={`${row.text}, [${row.numbers}]`}
          onClick={() => setExpanded(flip(expanded, row.id))}
        >
          <span aria-hidden="true" className="assistant-group-caret">{open ? "▾" : "▸"}</span>
          <span className="summary-chip assistant-marker" aria-hidden="true">[{row.numbers}]</span>
          <span className="assistant-source-label">{row.text}</span>
          {open ? <span className="assistant-group-hide">{ASSISTANT_COPY.groupHide}</span> : null}
        </button>
        {open ? (
          <>
            <ul>{shown.map((entry) => rowOf(entry, true))}</ul>
            {rest > 0 ? (
              <p className="assistant-group-more">
                <span>{moreInGroupText(rest)}</span>{" "}
                <button
                  type="button"
                  className="assistant-group-show-all"
                  onClick={() => {
                    focusAfterShowAll.current = row.members[shown.length]?.key;
                    setAllShown(new Set([...allShown, row.id]));
                  }}
                >
                  {ASSISTANT_COPY.showAll}
                </button>
              </p>
            ) : null}
          </>
        ) : null}
      </li>
    );
  };
  return (
    <>
      <p className="assistant-sources-title">
        <span>{rowStateOf !== undefined ? pageSourcesText(entries.length) : hasGroup ? sourcesGroupedText(entries.length) : sourcesText(entries.length)}</span>
        {rowStateOf === undefined ? null : <span className="assistant-sources-hint">{ASSISTANT_COPY.selectHint}</span>}
      </p>
      <ul>{rows.map((row) => (row.kind === "group" ? groupOf(row) : rowOf(row.entry, false)))}</ul>
    </>
  );
}
