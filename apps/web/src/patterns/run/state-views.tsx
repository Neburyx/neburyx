import { useEffect, useRef } from 'react';
import type { PatternUnavailable } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';
import { canRetry } from '../../failure-notice.js';
import { SAVED_COPY, UNAVAILABLE_TEXT, stepWhere } from '../saved/saved-copy.js';
import { failureView } from '../copy.js';
import { TRY_AGAIN } from '../failure-words.js';
import { RunFailure } from '../run-failure.js';
import { RUN_COPY } from './run-copy.js';

type Reasons = PatternUnavailable['reasons'];

/** One sentence for each reason a pattern cannot run now, with the step it names; no code and no name from the definition. */
export function ReasonSentences({ reasons }: { readonly reasons: Reasons }) {
  return (
    <>
      {reasons.map((reason, index) => (
        <p key={`${reason.code}-${index}`}>
          {UNAVAILABLE_TEXT[reason.code]}
          {stepWhere(reason.path)}
        </p>
      ))}
    </>
  );
}

interface OutOfDateProps {
  readonly reasons: Reasons;
  /** Change pattern for a pattern of the person's own, Copy and change for another person's shared one; nothing for a pattern that has no definition to change. */
  readonly offer: 'change' | 'copy' | undefined;
  readonly onChange: () => void;
  readonly onCopyAndChange: () => void;
}

/** The pattern that cannot run against the current mapping (PB19 state 8): the reasons in words, Run off, and the way to fix it. */
export function OutOfDate({ reasons, offer, onChange, onCopyAndChange }: OutOfDateProps) {
  const headline = useRef<HTMLParagraphElement>(null);
  useEffect(() => headline.current?.focus(), []);
  return (
    <>
      <div className="run-body">
        <div className="patterns-state" data-tone="warning" role="alert">
          <p className="run-strong" tabIndex={-1} ref={headline}>
            {SAVED_COPY.unavailable}
          </p>
          <ReasonSentences reasons={reasons} />
          {offer === undefined ? null : <p>{offer === 'copy' ? SAVED_COPY.copyAndChangeNote : SAVED_COPY.outOfDateLine}</p>}
        </div>
      </div>
      <div className="run-footer">
        <button type="button" className="primary" disabled>
          {RUN_COPY.run}
        </button>
        {offer === 'change' ? (
          <button type="button" className="secondary" onClick={onChange}>
            {SAVED_COPY.changePattern}
          </button>
        ) : null}
        {offer === 'copy' ? (
          <button type="button" className="secondary" onClick={onCopyAndChange}>
            {SAVED_COPY.copyAndChange}
          </button>
        ) : null}
      </div>
    </>
  );
}

interface EmptyMineProps {
  /** The panel returns the focus here when the editor closes, since this button is the panel's + New pattern while the list is empty. */
  readonly newRef?: React.RefObject<HTMLButtonElement | null>;
  readonly onNew: () => void;
  readonly onSeeBuiltIn: () => void;
}

/** No patterns of your own (PB19 state 5): where to start, + New pattern and See built-in. */
export function EmptyMine({ newRef, onNew, onSeeBuiltIn }: EmptyMineProps) {
  return (
    <div className="patterns-state patterns-empty">
      <p>{SAVED_COPY.emptyMine}</p>
      <div className="patterns-actions">
        <button type="button" className="primary" ref={newRef} onClick={onNew}>
          <span aria-hidden="true">+ </span>
          {SAVED_COPY.newPattern}
        </button>
        <button type="button" className="secondary" onClick={onSeeBuiltIn}>
          {SAVED_COPY.seeBuiltIn}
        </button>
      </div>
    </div>
  );
}

interface UnreadableProps {
  readonly failure: ApiFailure;
  readonly sourceName: string;
  readonly retry: () => void;
}

/** A list that cannot be read (PB19 state 2): the sentence of the table, what stayed as it was, and Try again where trying again can help; a rate limit counts down. */
export function ListUnreadable({ failure, sourceName, retry }: UnreadableProps) {
  const view = failureView(failure, sourceName);
  return <RunFailure failure={{ ...view, action: view.action ?? TRY_AGAIN }} canRetry={canRetry(failure)} onRetry={retry} />;
}
