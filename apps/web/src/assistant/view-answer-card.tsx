import { useId, useState } from "react";
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
import { TableBlock } from "./table-block.js";
import type { ViewAnswer } from "./assistant-session.js";

type Block = ViewAnswer["blocks"][number];
type SentencesBlock = Extract<Block, { kind: "sentences" }>;

const labelOf = (entry: CitationEntry): string =>
  entry.label ??
  `${entry.kind === "entity" ? SUMMARY_COPY.entity : SUMMARY_COPY.relationship} ${entry.key}`;

/** `heading` shows a visible title in place of the hidden one, and `sources: false` leaves out the list of sources: the overview beside a refusal is drawn so. */
export function ViewAnswerCard({
  answer,
  entries,
  heading,
  sources = true,
}: {
  readonly answer: ViewAnswer;
  readonly entries: readonly CitationEntry[];
  readonly heading?: string;
  readonly sources?: boolean;
}) {
  const titleId = useId();
  const sourcesId = useId();
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [sourcesOpen, setSourcesOpen] = useState(false);
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
  const press = (entry: CitationEntry): void => {
    const outcome = pressOf(entry, drawn, held, SUMMARY_COPY);
    if (outcome.kind === "note") {
      setNote(outcome.text);
      return;
    }
    setNote("");
    state.presentation.select([entry.graphKey]);
  };
  const status = (entry: CitationEntry): string =>
    drawn.has(entry.graphKey)
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
        setSourcesOpen(true);
        setFocusRequest({ number: first.number, tick: (focusRequest?.tick ?? 0) + 1 });
      }}
    >
      [{first.number}–{last.number}]
    </button>
  );
  const descriptionKeys = (cites: readonly string[]): readonly string[] => cites.filter((key) => meanings.has(key));
  const readKeys = (cites: readonly string[]): readonly string[] => cites.filter((key) => reads.has(key));
  const sentencesOf = (shown: SentencesBlock) => (
    <ol className="summary-sentences">
      {shown.sentences.map((sentence, index) => (
        <li key={index} className="summary-block">
          <p className="assistant-sentence">
            {sentence.text}
            {markerGroups(sentence.cites.flatMap((key) => byKey.get(key) ?? []), sources && entries.length > 0).map((group) => (
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
    </ol>
  );
  const showSourceOf = (entry: CitationEntry): void => {
    setSourcesOpen(true);
    setFocusRequest({ number: entry.number, tick: (focusRequest?.tick ?? 0) + 1 });
  };
  const entriesOf = (cites: readonly string[]): readonly CitationEntry[] => cites.flatMap((key) => byKey.get(key) ?? []);
  const markersOf = (cites: readonly string[]) =>
    markerGroups(entriesOf(cites), sources && entries.length > 0).map((group) => (
      <span key={group.kind === "run" ? `${group.first.key}-run` : group.entry.key}>
        {group.kind === "run" ? runMarkerOf(group.first, group.last) : markerOf(group.entry)}
      </span>
    ));
  /** One marker for a row: its own element's number, then how many more it cites ("[4] +2"), or the range when its elements form a run; it selects every drawn element the row cites, as a sentence marker does, and its name and tooltip give each element's number, label and status. A row of one element has the marker of that element. */
  const rowMarkersOf = (cites: readonly string[]) => {
    const cited = entriesOf(cites);
    const first = cited[0];
    const last = cited.at(-1);
    if (first === undefined || last === undefined || cited.length < 2 || !(sources && entries.length > 0)) return markersOf(cites);
    const run = cited.length >= MARKER_RUN_MIN && cited.every((entry, index) => entry.number === first.number + index);
    const name = rowCitationsLabel(cited.map((entry) => `${ASSISTANT_COPY.citationNumber} ${entry.number}, ${labelOf(entry)}, ${status(entry).toLowerCase()}`));
    return (
      <button type="button" className="summary-chip assistant-marker" aria-label={name} title={name} onClick={() => selectRow(cites)}>
        {run ? `[${first.number}–${last.number}]` : `[${first.number}] +${cited.length - 1}`}
      </button>
    );
  };
  const markerTextOf = (cites: readonly string[]): string =>
    markerGroups(entriesOf(cites), sources && entries.length > 0)
      .map((group) => (group.kind === "run" ? `[${group.first.number}–${group.last.number}]` : `[${group.entry.number}]`))
      .join(" ");
  const selectRow = (cites: readonly string[]): void => {
    const keys = entriesOf(cites).map((entry) => entry.graphKey).filter((key) => drawn.has(key));
    if (keys.length === 0) {
      setNote(SUMMARY_COPY.gone);
      return;
    }
    setNote("");
    state.presentation.select(keys);
  };
  const blockOf = (block: Block, index: number) =>
    block.kind === "sentences" ? (
      <div key={index}>{sentencesOf(block)}</div>
    ) : (
      <TableBlock
        key={index}
        table={block.table}
        markersOf={rowMarkersOf}
        markerTextOf={markerTextOf}
        firstEntryOf={(cites) => entriesOf(cites)[0]}
        onSelectRow={selectRow}
        onShowSource={sources && entries.length > 0 ? showSourceOf : undefined}
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
      <div className="summary-tags">
        <span className="summary-tag summary-tag-accent">
          {ASSISTANT_COPY.drafted}
        </span>
        <span className="summary-tag">{`${ASSISTANT_COPY.modelTag}: ${answer.model}`}</span>
      </div>
      {answer.blocks.map(blockOf)}
      {answer.noDescription === undefined ? null : <p className="assistant-no-description">{answer.noDescription}</p>}
      {answer.pointer === undefined ? null : <p className="assistant-pointer">{answer.pointer}</p>}
      {answer.lastCallNote === undefined ? null : <p className="assistant-pointer">{answer.lastCallNote}</p>}
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
              <SourcesList entries={entries} labelOf={labelOf} statusOf={status} isSelectable={(entry) => drawn.has(entry.graphKey)} onPress={press} focusRequest={focusRequest} onFocusHandled={() => setFocusRequest(undefined)} />
            </div>
          ) : null}
        </div>
      )}
      <p className="summary-note" role="status">
        {note}
      </p>
      {"reads" in answer ? <ReadSteps reads={answer.reads} /> : null}
      <div className="assistant-coverage">
        <p>{ASSISTANT_COPY.coverage}</p>
        {"summaryCited" in answer.coverage && answer.coverage.summaryCited !== undefined ? <p>{answer.coverage.summaryCited}</p> : null}
        <p>{answer.coverage.retrieval}</p>
        <p>{answer.coverage.summary}</p>
      </div>
    </section>
  );
}
