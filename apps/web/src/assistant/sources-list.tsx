import { useEffect, useRef, useState } from "react";
import type { CitationEntry } from "../summary/summary-model.js";
import { ASSISTANT_COPY, GROUP_MEMBERS_SHOWN, moreInGroupText, sourcesGroupedText, sourcesText } from "./copy.js";
import { groupSources, type SourceRow } from "./source-groups.js";

export function SourcesList({
  entries,
  labelOf,
  statusOf,
  isSelectable,
  onPress,
  focusRequest,
  onFocusHandled,
}: {
  readonly entries: readonly CitationEntry[];
  readonly labelOf: (entry: CitationEntry) => string;
  readonly statusOf: (entry: CitationEntry) => string;
  readonly isSelectable: (entry: CitationEntry) => boolean;
  readonly onPress: (entry: CitationEntry) => void;
  readonly focusRequest: { readonly number: number; readonly tick: number } | undefined;
  readonly onFocusHandled: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allShown, setAllShown] = useState<ReadonlySet<string>>(new Set());
  const focusAfterShowAll = useRef<string | undefined>(undefined);
  const rows = groupSources(entries);
  const lines = useRef(new Map<number, HTMLButtonElement>());
  const target = focusRequest?.number;
  useEffect(() => {
    if (target === undefined) return;
    lines.current.get(target)?.focus();
    onFocusHandled();
  }, [target, focusRequest?.tick, onFocusHandled]);
  const hasGroup = rows.some((row) => row.kind === "group");
  const flip = (held: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(held);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const rowOf = (entry: CitationEntry, nested: boolean) => (
    <li key={entry.key} className={nested ? "assistant-source-member" : undefined}>
      <button
        type="button"
        className="assistant-source-row"
        ref={(button) => {
          if (button !== null && !nested) lines.current.set(entry.number, button);
          if (button === null || focusAfterShowAll.current !== entry.key) return;
          focusAfterShowAll.current = undefined;
          button.focus();
        }}
        title={statusOf(entry)}
        aria-label={`${ASSISTANT_COPY.sources}: ${entry.number}, ${labelOf(entry)}. ${statusOf(entry)}`}
        onClick={() => onPress(entry)}
      >
        <span className="summary-chip assistant-marker" aria-hidden="true">[{entry.number}]</span>
        <span className="assistant-source-label">
          {labelOf(entry)}
          {isSelectable(entry) ? null : <span className="summary-chip-note">{statusOf(entry)}</span>}
        </span>
      </button>
    </li>
  );
  const groupOf = (row: Extract<SourceRow, { kind: "group" }>) => {
    const open = expanded.has(row.id);
    const shown = allShown.has(row.id) ? row.members : row.members.slice(0, GROUP_MEMBERS_SHOWN);
    const rest = row.members.length - shown.length;
    return (
      <li key={row.id} className="assistant-source-group">
        <button
          type="button"
          className="assistant-source-row assistant-group-line"
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
      <p className="assistant-sources-title">{hasGroup ? sourcesGroupedText(entries.length) : sourcesText(entries.length)}</p>
      <ul>{rows.map((row) => (row.kind === "group" ? groupOf(row) : rowOf(row.entry, false)))}</ul>
    </>
  );
}
