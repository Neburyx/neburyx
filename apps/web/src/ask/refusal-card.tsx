import { ASK_REFUSAL_SENTENCES } from '@neburyx/contracts';
import { useState } from 'react';
import { useClientState } from '../state/context.js';
import { useTools } from '../workspace/tool-registry.js';
import { ASK_COPY } from './copy.js';
import type { Refused } from './ask-session.js';
import { CHIP_LABELS, chipsOf, EXPAND_HINT, isPathsTool, type RefusalChip } from './refusal-chips.js';
import { causeTag, hintOf, humanize, SHOWS_INPUTS } from './text.js';

const namesOf = (names: readonly string[]): string => (names.length === 0 ? ASK_COPY.none : names.map(humanize).join(', '));

interface InputLine {
  readonly label: string;
  readonly text: string;
  /** Drawn in the colour of a problem: what is missing, what is extra, what was found but is not valid. */
  readonly problem: boolean;
}

/** One card for every cause: the fixed sentence, the question as typed, the lines of the intent's inputs where they help, what to try, and the manual tools. The words of the model never reach it. */
export function RefusalCard({ refused, question }: { readonly refused: Refused; readonly question: string }) {
  const state = useClientState();
  const tools = useTools();
  const [hint, setHint] = useState(false);
  const paths = tools.find((tool) => tool.id === 'paths');
  const run = (chip: RefusalChip): void => {
    if (chip === 'expand') {
      setHint(true);
      return;
    }
    if (chip === 'search-id') state.presentation.setSearchTab('source');
    const tool = tools.find((entry) => entry.id === (chip === 'paths' ? 'paths' : chip === 'filters' ? 'filters' : 'search'));
    if (tool?.kind.type === 'action') tool.kind.activate();
  };
  const lines: readonly InputLine[] = SHOWS_INPUTS.has(refused.cause)
    ? [
        ...(refused.parameters === undefined ? [] : [{ label: ASK_COPY.needs, text: namesOf(refused.parameters), problem: false }]),
        ...(refused.found === undefined ? [] : [{ label: ASK_COPY.found, text: namesOf(refused.found), problem: refused.cause === 'invalid-inputs' }]),
        ...(refused.missing === undefined || refused.cause !== 'missing-inputs' ? [] : [{ label: ASK_COPY.missing, text: namesOf(refused.missing), problem: true }]),
        ...(refused.extra === undefined || refused.cause !== 'extra-inputs' ? [] : [{ label: ASK_COPY.extra, text: namesOf(refused.extra), problem: true }]),
      ]
    : refused.cause === 'nothing-found' && refused.intent !== undefined
      ? [{ label: ASK_COPY.used, text: humanize(refused.intent), problem: false }]
      : [];
  const advice = hintOf(refused.cause);
  return (
    <section className="ask-refusal" aria-labelledby="ask-refusal-title" role="alert">
      <div className="ask-refusal-head">
        <h3 id="ask-refusal-title" tabIndex={-1} data-ask-focus="title">
          {ASK_COPY.refusalTitle}
        </h3>
        <span className="ask-tag ask-tag-cause">{causeTag(refused.cause)}</span>
      </div>
      <p className="ask-refusal-sentence">{ASK_REFUSAL_SENTENCES[refused.cause]}</p>
      {question === '' ? null : (
        <div className="ask-typed">
          <p className="ask-typed-title">{ASK_COPY.yourQuestion}</p>
          <p className="ask-typed-text">{question}</p>
        </div>
      )}
      {lines.length === 0 ? null : (
        <dl className="ask-lines">
          {lines.map((line) => (
            <div key={line.label} className="ask-line">
              <dt className={line.problem ? 'ask-problem' : undefined}>{line.label}</dt>
              <dd className={line.problem ? 'ask-problem' : undefined}>{line.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {advice === undefined ? null : <p className="ask-hint">{advice}</p>}
      <p className="ask-by-hand">{ASK_COPY.byHand}</p>
      <div className="ask-chips">
        {chipsOf(refused.cause, isPathsTool(paths)).map((chip) => (
          <button key={chip} type="button" className="ask-chip" onClick={() => run(chip)}>
            {CHIP_LABELS[chip]}
          </button>
        ))}
      </div>
      {hint ? <p className="ask-note">{EXPAND_HINT}</p> : null}
    </section>
  );
}
