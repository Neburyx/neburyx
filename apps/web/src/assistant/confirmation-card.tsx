import { useId } from 'react';
import { humanize } from '../ask/text.js';
import { ASSISTANT_COPY } from './copy.js';
import type { Waiting } from './assistant-session.js';
import { ReadSteps } from './read-steps.js';

const figure = (value: number): string => value.toLocaleString('en-US');
const rowsOf = (value: number): string => `${figure(value)} ${value === 1 ? 'row' : 'rows'}`;

const QUALITY_CHIPS = { exact: 'Exact', estimated: 'Estimated', lowerBound: 'Lower bound', unknown: 'Unknown' } as const;

/** The question of the card: the tool and, when there is one, its subject, in fixed words. A tool or subject with markup in it is text. */
export const confirmationQuestion = (step: Waiting['step']): string => `Read ${humanize(step.tool)}${step.subject === undefined ? '' : ` for ${step.subject}`}?`;

/** What the step would read: a fixed sentence with the subject and the size of the page. */
export const confirmationSentence = (step: Waiting['step']): string => `This read ${step.subject === undefined ? '' : `of ${step.subject} `}is larger than one page. This would read one page of ${rowsOf(step.page)}.`;

/** The count the step stopped at, written with the quality of the count, and no number when it is not known. */
function countLine(step: Waiting['step']): string | undefined {
  const { quality, value } = step.count;
  if (value === undefined || quality === 'unknown') return undefined;
  return quality === 'lowerBound' ? `≥ ${rowsOf(value)}` : quality === 'estimated' ? `~ ${rowsOf(value)} (estimated)` : rowsOf(value);
}

export interface ConfirmationCardProps {
  readonly waiting: Waiting;
  readonly onConfirm: () => void;
  readonly onSkip: () => void;
  readonly onCancel: () => void;
}

/**
 * A heavy step waits for the analyst: the reads so far above, then the card with what the step would read, Confirm, Skip and Cancel, and under it what each does. Focus is on the title when the card appears.
 */
export function ConfirmationCard({ waiting, onConfirm, onSkip, onCancel }: ConfirmationCardProps) {
  const titleId = useId();
  const count = countLine(waiting.step);
  return (
    <>
      <ReadSteps reads={waiting.reads} open />
      <section className="assistant-waiting" aria-labelledby={titleId}>
        <p className="assistant-waiting-label">{ASSISTANT_COPY.waitingLabel}</p>
        <h3 id={titleId} tabIndex={-1} data-ask-focus="title">
          {confirmationQuestion(waiting.step)}
        </h3>
        <p>{confirmationSentence(waiting.step)}</p>
        <p className="assistant-waiting-count">
          {count === undefined ? null : <span>{count}</span>}
          <span className="ask-tag ask-tag-caution">{QUALITY_CHIPS[waiting.step.count.quality]}</span>
        </p>
        <div className="assistant-waiting-actions">
          <button type="button" className="ask-send" onClick={onConfirm}>
            {ASSISTANT_COPY.confirm}
          </button>
          <button type="button" className="ask-continue ask-send-cancel" onClick={onSkip}>
            {ASSISTANT_COPY.skip}
          </button>
          <button type="button" className="ask-continue ask-send-cancel" onClick={onCancel}>
            {ASSISTANT_COPY.cancel}
          </button>
        </div>
        <p className="assistant-waiting-note">{ASSISTANT_COPY.waitingSkipNote}</p>
      </section>
      <p className="assistant-limit-note">{ASSISTANT_COPY.waitingNothingRuns}</p>
    </>
  );
}
