import { useId, useState } from "react";
import { useClientState, useVisibleGraph } from "../state/context.js";
import { useStoreSelector } from "../state/store.js";
import { drawnKeys } from "../state/loaded-graph.js";
import { elementKey, edgeKey } from "../state/keys.js";
import { SUMMARY_COPY } from "../summary/copy.js";
import { pressOf, type CitationEntry } from "../summary/summary-model.js";
import { ASSISTANT_COPY } from "./copy.js";
import { ReadSteps } from "./read-steps.js";
import type { ViewAnswer } from "./assistant-session.js";

const labelOf = (entry: CitationEntry): string =>
  entry.label ??
  `${entry.kind === "entity" ? SUMMARY_COPY.entity : SUMMARY_COPY.relationship} ${entry.key}`;

export function ViewAnswerCard({
  answer,
  entries,
}: {
  readonly answer: ViewAnswer;
  readonly entries: readonly CitationEntry[];
}) {
  const titleId = useId();
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const [note, setNote] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const meanings = new Map(
    answer.citations.flatMap((citation) => (citation.kind === "description" ? [[citation.key, citation] as const] : [])),
  );
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
  return (
    <section className="assistant-view-answer" aria-labelledby={titleId}>
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
      <div className="summary-tags">
        <span className="summary-tag summary-tag-accent">
          {ASSISTANT_COPY.drafted}
        </span>
        <span className="summary-tag">{`${ASSISTANT_COPY.modelTag}: ${answer.model}`}</span>
      </div>
      <ol className="summary-sentences">
        {answer.sentences.map((sentence, index) => (
          <li key={index} className="summary-block">
            <p className="assistant-sentence">{sentence.text}</p>
            <span className="summary-chips">
              {sentence.cites.map((key) => {
                const meaning = meanings.get(key);
                if (meaning !== undefined) {
                  return (
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
                }
                const entry = byKey.get(key);
                return entry === undefined ? null : (
                  <button
                    key={key}
                    type="button"
                    className="summary-chip"
                    aria-label={`${ASSISTANT_COPY.citationNumber} ${entry.number}, ${labelOf(entry)}, ${status(entry).toLowerCase()}`}
                    onClick={() => press(entry)}
                  >
                    <span aria-hidden="true">[{entry.number}]</span>{" "}
                    {labelOf(entry)}
                  </button>
                );
              })}
            </span>
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
      {answer.noDescription === undefined ? null : <p className="assistant-no-description">{answer.noDescription}</p>}
      {entries.length === 0 ? null : (
        <details className="assistant-sources" open>
          <summary>{`${ASSISTANT_COPY.sources} · ${entries.length}`}</summary>
          <ul>
            {entries.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className="summary-chip"
                  aria-label={`${ASSISTANT_COPY.sources}: ${labelOf(entry)}. ${status(entry)}`}
                  onClick={() => press(entry)}
                >
                  <span aria-hidden="true">[{entry.number}]</span>{" "}
                  {labelOf(entry)}{" "}
                  <span className="summary-chip-note">{status(entry)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
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
