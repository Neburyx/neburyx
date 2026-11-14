import { useEffect, useId, useState } from 'react';
import type { AskSummary } from '@neburyx/contracts';
import { heldKeysOf } from '../api/merge-into-loaded.js';
import { useClientState } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { addableOf } from './plan-result-model.js';
import { SUMMARY_COPY, citationKey, markerNumber, pressOutcome, sourcesLabel, sourcesOf } from './plan-summary-model.js';
import type { PlanPanel } from './use-plan.js';

/**
 * The answer under a result: the sentences as the server wrote them, a marker after each citation, the omissions line and a list of the sources. A marker selects the element on the canvas when it is drawn, and says why
 * when it is not. Nothing is read: the title and type of a source are those that arrived.
 */
export function SummaryView({ panel, summary }: { readonly panel: PlanPanel; readonly summary: AskSummary }) {
  const state = useClientState();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { stage } = panel;
  const added = stage.kind === 'result' ? stage.added : undefined;
  // what was said about an element that was not on the graph no longer holds once the result is added
  useEffect(() => setNote(''), [added]);
  if (stage.kind !== 'result') return null;
  const titleOf = new Map(summary.citations.map((citation) => [citation.key, citation]));
  const press = (key: string): void => {
    const citation = titleOf.get(key);
    if (citation === undefined) return;
    const held = heldKeysOf(state);
    const outcome = pressOutcome({ key: citationKey(citation), held: new Set([...held.nodes, ...held.edges]), drawn: drawnKeys(state.visibleGraph()), addable: addableOf(stage.run.result), added: stage.added !== undefined });
    if (outcome.kind === 'select') {
      state.presentation.select([outcome.key]);
      setNote('');
    } else {
      // cleared first, so a second press that gives the same words is announced again
      setNote('');
      queueMicrotask(() => setNote(outcome.text));
    }
  };
  return (
    <section className="ask-summary" aria-label={SUMMARY_COPY.heading}>
      <h4 className="ask-summary-heading">{SUMMARY_COPY.heading}</h4>
      <ul className="ask-summary-sentences">
        {summary.sentences.map((sentence, index) => (
          <li key={index}>
            {sentence.text}
            {sentence.cites.map((key) => (
              <button key={key} type="button" className="ask-summary-marker" aria-label={`Source ${markerNumber(key)}: ${titleOf.get(key)?.title ?? ''}`} onClick={() => press(key)}>
                [{markerNumber(key)}]
              </button>
            ))}
          </li>
        ))}
      </ul>
      {summary.omissions === undefined ? null : <p className="ask-note">{summary.omissions}</p>}
      <p className="ask-note" role="status">
        {note}
      </p>
      <button type="button" className="ask-summary-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        {sourcesLabel(summary.citations.length)}
      </button>
      {open ? (
        <ol id={listId} className="ask-summary-sources">
          {sourcesOf(summary).map(({ number, citation }) => (
            <li key={citation.key} value={Number(number)}>
              <span className="ask-summary-type">{citation.type}</span> {citation.title}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
