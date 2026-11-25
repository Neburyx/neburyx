import { useId, useState, type ReactNode } from "react";
import { useClientState, useVisibleGraph } from "../state/context.js";
import { useStoreSelector } from "../state/store.js";
import { drawnKeys } from "../state/loaded-graph.js";
import { elementKey, edgeKey } from "../state/keys.js";
import { SUMMARY_COPY } from "../summary/copy.js";
import { pressOf, type CitationEntry } from "../summary/summary-model.js";
import { ASSISTANT_COPY, MARKER_RUN_MIN, citationRangeLabel, rowCitationsLabel } from "./copy.js";
import { ReadSteps } from "./read-steps.js";
import { markerGroups } from "./marker-runs.js";
import { SourcesList } from "./sources-list.js";
import { rowStateOf } from "./row-state.js";
import { useRowSelection, useSourceSelection } from "./source-selection-context.js";
import { TableBlock } from "./table-block.js";
import type { ViewAnswer } from "./assistant-session.js";

export interface SourcesControl {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly focusRequest: { readonly number: number; readonly tick: number } | undefined;
  readonly onFocusHandled: () => void;
}

type Block = ViewAnswer["blocks"][number];
type ListBlock = Extract<Block, { kind: "list" }>;

const labelOf = (entry: CitationEntry): string =>
  entry.label ??
  `${entry.kind === "entity" ? SUMMARY_COPY.entity : SUMMARY_COPY.relationship} ${entry.key}`;

/** `heading` shows a visible title in place of the hidden one, and `sources: false` leaves out the list of sources: the overview beside a refusal is drawn so. */
export function ViewAnswerCard({
  answer,
  entries,
  heading,
  sources = true,
  stored = false,
  renderSources,
}: {
  readonly answer: ViewAnswer;
  readonly entries: readonly CitationEntry[];
  readonly heading?: string;
  readonly sources?: boolean;
  /** An earlier answer from the thread: its read steps are not kept and are not drawn, and its model and its coverage are drawn only when it was stored with them. */
  readonly stored?: boolean;
  /** The control of the sources an earlier answer is given instead of the built-in one, drawn where that one stands, with the state a range marker opens it by. */
  readonly renderSources?: (control: SourcesControl) => ReactNode;
}) {
  const titleId = useId();
  const sourcesId = useId();
  const listOwner = useId();
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const folds = (sources || renderSources !== undefined) && entries.length > 0;
  const [focusRequest, setFocusRequest] = useState<{ readonly number: number; readonly tick: number } | undefined>(undefined);
  const meanings = new Map(
    answer.citations.flatMap((citation) => (citation.kind === "description" ? [[citation.key, citation] as const] : [])),
  );
  const reads = new Map(answer.citations.flatMap((citation) => (citation.kind === "read" ? [[citation.key, citation] as const] : [])));
  const toggle = (key: string): void => {
    const next = new Set(opened);
    if (!next.delete(key)) next.add(key);
    setOpened(next);
  };
  const drawn = drawnKeys(graph);
  const held = new Set([
    ...investigation.nodeRefs.map(elementKey),
    ...investigation.edgeRefs.map(edgeKey),
  ]);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const page = useSourceSelection();
  const rowSelection = useRowSelection();
  const press = (entry: CitationEntry): void => {
    if (page !== undefined) {
      if (held.has(entry.graphKey)) {
        setNote("");
        page.selection.select(entry.graphKey, listOwner);
      } else setNote(SUMMARY_COPY.gone);
      return;
    }
    const outcome = pressOf(entry, drawn, held, SUMMARY_COPY);
    if (outcome.kind === "note") {
      setNote(outcome.text);
      return;
    }
    setNote("");
    state.presentation.select([entry.graphKey]);
  };
  const status = (entry: CitationEntry): string =>
    drawn.has(entry.graphKey) || (page !== undefined && held.has(entry.graphKey))
      ? SUMMARY_COPY.select
      : held.has(entry.graphKey)
        ? SUMMARY_COPY.outsideView
        : SUMMARY_COPY.gone;
  const markerOf = (entry: CitationEntry) => (
    <button
      type="button"
      className="summary-chip assistant-marker"
      aria-label={`${ASSISTANT_COPY.citationNumber} ${entry.number}, ${labelOf(entry)}, ${status(entry).toLowerCase()}`}
      onClick={() => press(entry)}
    >
      [{entry.number}]
    </button>
  );
  const runMarkerOf = (first: CitationEntry, last: CitationEntry) => (
    <button
      type="button"
      className="summary-chip assistant-marker"
      aria-label={citationRangeLabel(first.number, last.number)}
      onClick={() => {
        selectEntries(entries.filter((entry) => entry.number >= first.number && entry.number <= last.number));
        setSourcesOpen(true);
        setFocusRequest({ number: first.number, tick: (focusRequest?.tick ?? 0) + 1 });
      }}
    >
      [{first.number}–{last.number}]
    </button>
  );
  const descriptionKeys = (cites: readonly string[]): readonly string[] => cites.filter((key) => meanings.has(key));
  const readKeys = (cites: readonly string[]): readonly string[] => cites.filter((key) => reads.has(key));
  const textsOf = (texts: readonly { readonly text: string; readonly cites: readonly string[] }[], bullets: { readonly labelledBy?: string } | undefined) => {
    const Tag = bullets === undefined ? "ol" : "ul";
    return (
    <Tag className={bullets === undefined ? "summary-sentences" : "summary-sentences assistant-list-items"} aria-labelledby={bullets?.labelledBy}>
      {texts.map((sentence, index) => (
        <li key={index} className="summary-block">
          <p className="assistant-sentence">
            {sentence.text}
            {markerGroups(sentence.cites.flatMap((key) => byKey.get(key) ?? []), folds).map((group) => (
              <span key={group.kind === "run" ? `${group.first.key}-run` : group.entry.key}>
                {" "}
                {group.kind === "run" ? runMarkerOf(group.first, group.last) : markerOf(group.entry)}
              </span>
            ))}
            {readKeys(sentence.cites).map((key) => {
              const read = reads.get(key);
              return read === undefined ? null : (
                <span key={key}>
                  {" "}
                  <button
                    type="button"
                    className="summary-chip assistant-marker assistant-read-chip"
                    aria-expanded={opened.has(key)}
                    aria-label={`${ASSISTANT_COPY.readCitation}: ${read.label}`}
                    onClick={() => toggle(key)}
                  >
                    [{read.label}]
                  </button>
                </span>
              );
            })}
          </p>
          {descriptionKeys(sentence.cites).length === 0 ? null : (
            <span className="summary-chips">
              {descriptionKeys(sentence.cites).map((key) => {
                const meaning = meanings.get(key);
                return meaning === undefined ? null : (
                  <button
                    key={key}
                    type="button"
                    className="summary-chip assistant-description-chip"
                    aria-expanded={opened.has(key)}
                    aria-label={`${ASSISTANT_COPY.aboutType} ${meaning.type}: ${ASSISTANT_COPY.operatorDescription}`}
                    onClick={() => toggle(key)}
                  >
                    {`${ASSISTANT_COPY.aboutType} ${meaning.type}`}
                  </button>
                );
              })}
            </span>
          )}
          {sentence.cites.flatMap((key) => {
            const read = reads.get(key);
            return read === undefined || !opened.has(key) ? [] : [
              <p key={key} className="assistant-description" role="note">
                <span className="assistant-description-mark">{ASSISTANT_COPY.serverWritten}</span>
                <span>{read.finding}</span>
              </p>,
            ];
          })}
          {sentence.cites.flatMap((key) => {
            const meaning = meanings.get(key);
            return meaning === undefined || !opened.has(key) ? [] : [
              <p key={key} className="assistant-description" role="note">
                <span className="assistant-description-mark">{ASSISTANT_COPY.operatorDescription}</span>
                <span>{meaning.description}</span>
              </p>,
            ];
          })}
        </li>
      ))}
    </Tag>
    );
  };
  const showSourceOf = (entry: CitationEntry): void => {
    setSourcesOpen(true);
    setFocusRequest({ number: entry.number, tick: (focusRequest?.tick ?? 0) + 1 });
  };
  const entriesOf = (cites: readonly string[]): readonly CitationEntry[] => cites.flatMap((key) => byKey.get(key) ?? []);
  const markersOf = (cites: readonly string[]) =>
    markerGroups(entriesOf(cites), folds).map((group) => (
      <span key={group.kind === "run" ? `${group.first.key}-run` : group.entry.key}>
        {group.kind === "run" ? runMarkerOf(group.first, group.last) : markerOf(group.entry)}
      </span>
    ));
  /** One marker for a row: its own element's number, then how many more it cites ("[4] +2"), or the range when its elements form a run; it selects every drawn element the row cites, as a sentence marker does, and its name and tooltip give each element's number, label and status. A row of one element has the marker of that element. */
  const rowMarkersOf = (cites: readonly string[]) => {
    const cited = entriesOf(cites);
    const first = cited[0];
    const last = cited.at(-1);
    if (first === undefined || last === undefined || cited.length < 2 || !(folds)) return markersOf(cites);
    const run = cited.length >= MARKER_RUN_MIN && cited.every((entry, index) => entry.number === first.number + index);
    const name = rowCitationsLabel(cited.map((entry) => `${ASSISTANT_COPY.citationNumber} ${entry.number}, ${labelOf(entry)}, ${status(entry).toLowerCase()}`));
    return (
      <button type="button" className="summary-chip assistant-marker" aria-label={name} title={name} onClick={() => selectRow(cites)}>
        {run ? `[${first.number}–${last.number}]` : `[${first.number}] +${cited.length - 1}`}
      </button>
    );
  };
  const markerTextOf = (cites: readonly string[]): string =>
    markerGroups(entriesOf(cites), folds)
      .map((group) => (group.kind === "run" ? `[${group.first.number}–${group.last.number}]` : `[${group.entry.number}]`))
      .join(" ");
  const selectEntries = (cited: readonly CitationEntry[]): void => {
    const keys = cited.map((entry) => entry.graphKey).filter((key) => drawn.has(key));
    if (keys.length === 0) {
      setNote(cited.some((entry) => held.has(entry.graphKey)) ? SUMMARY_COPY.outsideView : SUMMARY_COPY.gone);
      return;
    }
    setNote("");
    state.presentation.select(keys);
  };
  const selectRow = (cites: readonly string[]): void => selectEntries(entriesOf(cites));
  const listOf = (block: ListBlock, index: number) => {
    const labelId = `${titleId}-list-${index}`;
    return (
      <div key={index} className="assistant-list-block">
        {block.label === undefined ? null : <p id={labelId} className="assistant-list-label">{block.label}</p>}
        {textsOf(block.items, block.label === undefined ? {} : { labelledBy: labelId })}
      </div>
    );
  };
  const blockOf = (block: Block, index: number) =>
    block.kind === "sentences" ? (
      <div key={index}>{textsOf(block.sentences, undefined)}</div>
    ) : block.kind === "list" ? (
      listOf(block, index)
    ) : (
      <TableBlock
        key={index}
        table={block.table}
        markersOf={rowMarkersOf}
        markerTextOf={markerTextOf}
        firstEntryOf={(cites) => entriesOf(cites)[0]}
        onSelectRow={selectRow}
        onShowSource={folds ? showSourceOf : undefined}
      />
    );
  return (
    <section className="assistant-view-answer" aria-labelledby={titleId}>
      {heading === undefined ? (
        <h3
          id={titleId}
          className="visually-hidden"
          tabIndex={-1}
          data-ask-focus="title"
        >
          {"steps" in answer
            ? ASSISTANT_COPY.sentencesFromReads
            : ASSISTANT_COPY.sentences}
        </h3>
      ) : (
        <h4 id={titleId} className="assistant-overview-heading">
          {heading}
        </h4>
      )}
      {stored && answer.model === "" ? null : (
        <div className="summary-tags">
          <span className="summary-tag summary-tag-accent">
            {ASSISTANT_COPY.drafted}
          </span>
          <span className="summary-tag">{`${ASSISTANT_COPY.modelTag}: ${answer.model}`}</span>
        </div>
      )}
      {answer.blocks.map(blockOf)}
      {answer.noDescription === undefined ? null : <p className="assistant-no-description">{answer.noDescription}</p>}
      {answer.pointer === undefined ? null : <p className="assistant-pointer">{answer.pointer}</p>}
      {answer.lastCallNote === undefined ? null : <p className="assistant-pointer">{answer.lastCallNote}</p>}
      {renderSources === undefined ? null : renderSources({ open: sourcesOpen, setOpen: setSourcesOpen, focusRequest, onFocusHandled: () => setFocusRequest(undefined) })}
      {entries.length === 0 || !sources ? null : (
        <div className="assistant-sources">
          <button
            type="button"
            className="assistant-sources-toggle"
            aria-expanded={sourcesOpen}
            aria-controls={sourcesId}
            onClick={() => setSourcesOpen(!sourcesOpen)}
          >
            <span aria-hidden="true" className="icon icon-layers" />
            <span>{`${ASSISTANT_COPY.sources} · ${entries.length}`}</span>
            <span aria-hidden="true" className="assistant-sources-caret">{sourcesOpen ? "▴" : "▾"}</span>
          </button>
          {sourcesOpen ? (
            <div id={sourcesId} className="assistant-sources-list">
              <SourcesList entries={entries} labelOf={labelOf} statusOf={status} isSelectable={(entry) => drawn.has(entry.graphKey) || (page !== undefined && held.has(entry.graphKey))} rowStateOf={page === undefined ? undefined : (entry) => (held.has(entry.graphKey) ? rowStateOf(entry.graphKey, listOwner, rowSelection, SUMMARY_COPY.select, () => page.openGraph(entry.graphKey)) : undefined)} onPress={press} focusRequest={focusRequest} onFocusHandled={() => setFocusRequest(undefined)} />
            </div>
          ) : null}
        </div>
      )}
      <p className={note === "" ? "summary-note visually-hidden" : "summary-note"} role="status">
        {note}
      </p>
      {stored ? null : "reads" in answer ? <ReadSteps reads={answer.reads} /> : null}
      {stored && answer.coverage.retrieval === "" ? null : (
        <div className="assistant-coverage">
          <p>{ASSISTANT_COPY.coverage}</p>
          {"summaryCited" in answer.coverage && answer.coverage.summaryCited !== undefined ? <p>{answer.coverage.summaryCited}</p> : null}
          <p>{answer.coverage.retrieval}</p>
          <p>{answer.coverage.summary}</p>
        </div>
      )}
    </section>
  );
}
