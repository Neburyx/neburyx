import { Fragment, useId, useState, type ReactNode } from 'react';
import { ASK_SAVED_PATTERN_INTENT, isPathSentence, pathSentenceStart, type AskSummary, AskSummaryCitation, Count } from '@neburyx/contracts';
import { heldKeysOf } from '../api/merge-into-loaded.js';
import type { AddedOutcome } from '../patterns/add-to-graph.js';
import { addedText } from '../patterns/copy.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { formatNumber } from '../workspace/scope-text.js';
import { addFirstLabel, addLabel, ASK_COPY } from './copy.js';
import { resultView, type CountFact } from './result-model.js';
import type { Answered } from './ask-session.js';
import { SUMMARY_COPY, citationKey, markerNumber, pressOutcome } from './summary-model.js';
import { humanize } from './text.js';

export const QUALITY_WORDS: Readonly<Record<Count['quality'], string>> = { exact: 'Exact', estimated: 'Estimated', lowerBound: 'Lower bound', unknown: 'Unknown' };

/** The figure of a count as the person reads it: the sign of its quality before the number, the noun after it. */
export function countFigure({ count, noun }: CountFact): string {
  if (count.value === undefined) return 'No count';
  const sign = count.quality === 'estimated' ? '~ ' : count.quality === 'lowerBound' ? '≥ ' : '';
  return `${sign}${formatNumber(count.value)} ${count.value === 1 ? noun : noun === 'match' ? 'matches' : `${noun}s`}`;
}

/** The count and its quality word, spoken in one phrase. */
export const countSpoken = (fact: CountFact): string => `${countFigure(fact)}, ${QUALITY_WORDS[fact.count.quality].toLowerCase()}`;

export function CountStrip({ fact, caution }: { readonly fact: CountFact; readonly caution?: boolean }) {
  const exact = fact.count.quality === 'exact';
  return (
    <div className={caution === true ? 'ask-count ask-count-caution' : 'ask-count'}>
      <span className="ask-count-figure">{countFigure(fact)}</span>
      <span className={exact ? 'ask-tag ask-tag-exact' : 'ask-tag ask-tag-caution'}>{QUALITY_WORDS[fact.count.quality]}</span>
    </div>
  );
}

/** What the question was taken as and the values taken from it: the first lines of every card that has a result. */
function Understood({ answer }: { readonly answer: Answered }) {
  const kind = answer.result.templateId === 'file-query' ? ASK_COPY.fromFileQuery : answer.patternName === undefined ? undefined : ASK_COPY.savedPattern;
  // the pattern of a saved-pattern answer is named by its internal id, which is not a value of the question; its starting entity reads as Start
  const saved = answer.intent === ASK_SAVED_PATTERN_INTENT;
  const entries = Object.entries(answer.entities).filter(([name]) => !saved || name !== 'pattern');
  return (
    <>
      <div className="ask-understood">
        <span className="ask-understood-label">{ASK_COPY.understoodAs}</span>
        <span className="ask-tag ask-tag-intent">{answer.patternName ?? answer.label ?? humanize(answer.intent)}</span>
        {kind === undefined ? null : <span className="ask-tag ask-tag-kind">{kind}</span>}
      </div>
      {entries.length === 0 ? null : (
        <div className="ask-values">
          <p className="ask-values-title">{ASK_COPY.values}</p>
          <dl className="ask-values-list">
            {entries.map(([name, value]) => (
              <div key={name} className="ask-values-row">
                <dt>{saved && name === 'anchor' ? ASK_COPY.start : humanize(name)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {answer.patternName === undefined ? null : <p className="ask-note">{ASK_COPY.patternPrivate}</p>}
    </>
  );
}

type SourceState = { readonly kind: 'selected' } | { readonly kind: 'select' } | { readonly kind: 'blocked'; readonly text: string };

interface Citations {
  readonly summary: AskSummary | undefined;
  stateOf(citation: AskSummaryCitation): SourceState;
  press(citation: AskSummaryCitation): void;
  markerLabel(citation: AskSummaryCitation): string;
  /** The marker button of a key, or nothing for a key the summary holds no citation for. */
  marker(key: string): ReactNode;
  sentence(text: string, cites: readonly string[]): ReactNode;
}

/** What a citation does when it is used, and how a marker reads: shared by the answer and by the cards that carry their own markers. */
function useCitations(summary: AskSummary | undefined, answer: Answered, added: boolean, onNote: (text: string) => void): Citations {
  const state = useClientState();
  const graph = useVisibleGraph();
  const selection = useStoreSelector(state.presentation.view, (view) => view.selection);
  const addable = resultView(answer.result).addable;
  const drawn = drawnKeys(graph);
  const held = heldKeysOf(state);
  const stateOf = (citation: AskSummaryCitation): SourceState => {
    const key = citationKey(citation);
    if (drawn.has(key)) return selection.has(key) ? { kind: 'selected' } : { kind: 'select' };
    const outcome = pressOutcome({ key, held: new Set([...held.nodes, ...held.edges]), drawn, addable, added });
    return { kind: 'blocked', text: outcome.kind === 'note' ? outcome.text : '' };
  };
  const byKey = new Map((summary?.citations ?? []).map((citation) => [citation.key, citation]));
  const press = (citation: AskSummaryCitation): void => {
    const outcome = stateOf(citation);
    if (outcome.kind === 'blocked') {
      onNote(outcome.text);
      return;
    }
    onNote('');
    state.presentation.select([citationKey(citation)]);
  };
  const markerLabel = (citation: AskSummaryCitation): string => {
    const outcome = stateOf(citation);
    const tail = outcome.kind === 'selected' ? SUMMARY_COPY.selected : outcome.kind === 'select' ? SUMMARY_COPY.select : outcome.text;
    return `Source ${markerNumber(citation.key)}, ${citation.title}, ${tail.toLowerCase()}`;
  };
  const marker = (key: string): ReactNode => {
    const citation = byKey.get(key);
    return citation === undefined ? null : (
      <button key={key} type="button" className="ask-marker" aria-label={markerLabel(citation)} onClick={() => press(citation)}>
        [{markerNumber(key)}]
      </button>
    );
  };
  const sentence = (text: string, cites: readonly string[]): ReactNode => (
    <>
      {text} {cites.map(marker)}
    </>
  );
  return { summary, stateOf, press, markerLabel, marker, sentence };
}

/** The sentences the Answer shows: all of them, but for a path answer only the heading, because each path's card carries the citations of its own path. */
function shownSentences(summary: AskSummary, answer: Answered): AskSummary['sentences'] {
  return answer.result.templateId === 'shortest-paths' ? summary.sentences.filter((sentence) => !isPathSentence(sentence.text)) : summary.sentences;
}

function Answer({ summary, answer, cites }: { readonly summary: AskSummary; readonly answer: Answered; readonly cites: Citations }) {
  const { stateOf, press, markerLabel, sentence } = cites;
  return (
    <>
      <section className="ask-section" aria-label={ASK_COPY.answer}>
        <h4 className="ask-section-title">{ASK_COPY.answer}</h4>
        <p className="ask-answer-text">
          {shownSentences(summary, answer).map((entry, index) => (
            <Fragment key={index}>{sentence(entry.text, entry.cites)} </Fragment>
          ))}
        </p>
      </section>
      <section className="ask-section" aria-label={ASK_COPY.sources}>
        <h4 className="ask-section-title">
          {ASK_COPY.sources} · {summary.citations.length}
        </h4>
        <ul className="ask-sources">
          {summary.citations.map((citation) => {
            const outcome = stateOf(citation);
            return (
              <li key={citation.key} className={outcome.kind === 'selected' ? 'ask-source ask-source-selected' : 'ask-source'}>
                <span className="ask-source-number" aria-hidden="true">
                  {markerNumber(citation.key)}
                </span>
                <span className="ask-source-name">
                  {citation.title} · {humanize(citation.type)}
                </span>
                {outcome.kind === 'blocked' ? (
                  <span className="ask-source-blocked">{outcome.text}</span>
                ) : (
                  <button type="button" className="ask-source-action" aria-label={markerLabel(citation)} onClick={() => press(citation)}>
                    {outcome.kind === 'selected' ? SUMMARY_COPY.selected : SUMMARY_COPY.select}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {summary.omissions === undefined ? null : <p className="ask-note">{summary.omissions}</p>}
      </section>
    </>
  );
}

/** The words of the button: the count only when the result lists as many as it counts; else the number it lists, so the label never claims more than it adds. */
function buttonLabel(view: ReturnType<typeof resultView>): string {
  const fact = view.count;
  const listed = view.listed ?? view.addable?.nodes.length ?? 0;
  if (fact === undefined) return addLabel(formatNumber(listed));
  const rows = fact.noun === 'row';
  if (fact.count.quality === 'exact' && fact.count.value === listed) return addLabel(formatNumber(listed));
  return addFirstLabel(formatNumber(listed), rows ? 'rows' : '');
}

/** The markers of one path: the citations of the sentence of the summary that begins with the path's own words, none for a path the summary left out. */
function pathMarkers(summary: AskSummary | undefined, position: number, cites: Citations): ReactNode {
  const entry = summary?.sentences.find((sentence) => sentence.text.startsWith(pathSentenceStart(position)));
  return entry === undefined ? null : [...entry.cites].sort((left, right) => Number(markerNumber(left)) - Number(markerNumber(right))).map(cites.marker);
}

export interface AnswerCardProps {
  readonly answer: Answered;
  readonly added: AddedOutcome | undefined;
  readonly canAdd: boolean;
  onAdd(): void;
}

/** What a question gave: what it was taken as, the count with its quality word, the notices, the rows of a file query, the answer with its sources, and Add to graph. */
export function AnswerCard({ answer, added, canAdd, onAdd }: AnswerCardProps) {
  const [note, setNote] = useState('');
  const view = resultView(answer.result);
  const cites = useCitations(answer.summary, answer, added !== undefined, setNote);
  const titleId = useId();
  return (
    <section className="ask-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="visually-hidden" tabIndex={-1} data-ask-focus="title">
        {ASK_COPY.ready}
      </h3>
      <Understood answer={answer} />
      {view.count === undefined ? (
        <dl className="ask-lines">
          {view.lines.map((line) => (
            <div key={line.label} className="ask-line">
              <dt>{line.label}</dt>
              <dd>{line.text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <CountStrip fact={view.count} />
      )}
      {answer.outcome === 'partial' ? <p className="ask-notice">{view.cutText ?? ASK_COPY.partial}</p> : null}
      {view.paths === undefined || view.paths.length === 0 ? null : (
        <ol className="ask-paths" aria-label={ASK_COPY.paths}>
          {view.paths.map((path) => (
            <li key={path.position} className="ask-path">
              <div className="ask-path-head">
                <h4 className="ask-path-title">{path.title}</h4>
                <span className="ask-path-cites">{pathMarkers(answer.summary, path.position, cites)}</span>
              </div>
              <ol className="ask-path-steps">
                {path.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
      {view.notices.map((notice) => (
        <p key={notice} className="ask-notice">
          {notice}
        </p>
      ))}
      {view.rows.length === 0 ? null : (
        <section className="ask-section" aria-label={ASK_COPY.rows}>
          <h4 className="ask-section-title">
            {ASK_COPY.rows} · {view.rows.length} {ASK_COPY.shown}
          </h4>
          <ul className="ask-rows">
            {view.rows.map((row, index) => (
              <li key={index}>{row}</li>
            ))}
          </ul>
        </section>
      )}
      {answer.summary === undefined ? null : <Answer summary={answer.summary} answer={answer} cites={cites} />}
      <p className="ask-note" role="status">
        {note}
      </p>
      {view.addable === undefined ? (
        <p className="ask-note">{ASK_COPY.nothingToDraw}</p>
      ) : added === undefined ? (
        <button type="button" className="ask-add" disabled={!canAdd} onClick={onAdd}>
          {buttonLabel(view)}
        </button>
      ) : (
        <p className="ask-note" role="status">
          {addedText(added, view.count?.count ?? { quality: 'exact', value: 0, scope: 'none' })}
        </p>
      )}
    </section>
  );
}

/** A result that would read more than the source allows without being asked: the estimate, and Continue. Nothing was read. */
export function HeavyCard({ answer, onContinue, body = ASK_COPY.heavyBody, note = ASK_COPY.heavyNote }: { readonly answer: Answered; readonly onContinue: () => void; readonly body?: string; readonly note?: string }) {
  const view = resultView(answer.result);
  const titleId = useId();
  return (
    <section className="ask-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="visually-hidden" tabIndex={-1} data-ask-focus="title">
        {ASK_COPY.stopped}
      </h3>
      <Understood answer={answer} />
      <div className="ask-heavy">
        {view.count === undefined ? null : (
          <div className="ask-count-row">
            <span className="ask-count-figure">{countFigure(view.count)}</span>
            <span className="ask-heavy-tag">{QUALITY_WORDS[view.count.count.quality]}</span>
          </div>
        )}
        <p>{body}</p>
        <button type="button" className="ask-continue" onClick={onContinue}>
          {ASK_COPY.continue}
        </button>
        <p>{note}</p>
      </div>
    </section>
  );
}
