import { useEffect, useState } from 'react';
import { failureWords, retryAfterMsOf } from '../failure-words.js';
import { FAILURE_KIND_TEXT, SUMMARY_COPY, TOO_LARGE_ELEMENTS_TEXT, TOO_LARGE_TEXT, tooLargeFigure } from './copy.js';
import { CoverageBox, Disclosure } from './draft-card.js';
import type { SummaryOutcome } from './summary-model.js';

interface OutcomeCardProps {
  readonly outcome: SummaryOutcome;
  readonly sourceId: string;
  readonly onTryAgain: () => void;
  readonly onReturn: () => void;
}

interface Words {
  readonly title: string;
  readonly text: string;
  readonly figure?: string;
  readonly icon?: 'document' | 'frame';
  readonly action: 'try-again' | 'unsupported' | 'return' | 'none';
  readonly waitMs?: number | undefined;
}

function wordsOf(outcome: SummaryOutcome, sourceId: string): Words {
  switch (outcome.kind) {
    case 'unsupported':
      return { title: SUMMARY_COPY.noSupport, text: SUMMARY_COPY.noSupportBody, icon: 'document', action: 'unsupported' };
    case 'too-large':
      return outcome.response.limit === 'elements'
        ? { title: SUMMARY_COPY.titleTooLarge, figure: tooLargeFigure(outcome.response.elements, outcome.response.cap), text: TOO_LARGE_ELEMENTS_TEXT, icon: 'frame', action: 'return' }
        : { title: SUMMARY_COPY.titleTooLarge, text: TOO_LARGE_TEXT, icon: 'frame', action: 'return' };
    case 'time-limit':
      return { title: SUMMARY_COPY.titleTimeLimit, text: SUMMARY_COPY.timeLimit, action: 'try-again' };
    case 'cancelled':
      return { title: SUMMARY_COPY.titleCancelled, text: SUMMARY_COPY.cancelled, action: 'try-again' };
    case 'failed':
      return { title: SUMMARY_COPY.titleFailed, text: FAILURE_KIND_TEXT[outcome.failureKind], action: 'try-again' };
    case 'request-failed': {
      const words = failureWords(outcome.failure, sourceId);
      return { title: SUMMARY_COPY.titleFailed, text: words.text, action: words.action === 'try-again' ? 'try-again' : 'none', waitMs: retryAfterMsOf(outcome.failure) };
    }
    case 'unavailable':
      return { title: SUMMARY_COPY.titleUnavailable, text: SUMMARY_COPY.unavailable, action: 'none' };
    case 'source-changed':
      return { title: SUMMARY_COPY.titleSourceChanged, text: SUMMARY_COPY.sourceChanged, action: 'none' };
    case 'cleared':
      return { title: SUMMARY_COPY.titleCleared, text: outcome.reason === 'masking' ? SUMMARY_COPY.clearedMasking : SUMMARY_COPY.clearedInvestigation, action: 'none' };
    default:
      return outcome satisfies never;
  }
}

function Icon({ kind }: { readonly kind: 'document' | 'frame' }) {
  return (
    <svg aria-hidden="true" className="summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      {kind === 'document' ? (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <circle cx="11" cy="13" r="2.5" />
          <path d="M13 15l2.5 2.5" />
        </>
      ) : (
        <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      )}
    </svg>
  );
}

function TryAgain({ waitMs, onTryAgain }: { readonly waitMs: number | undefined; readonly onTryAgain: () => void }) {
  const [waiting, setWaiting] = useState(waitMs !== undefined && waitMs > 0);
  useEffect(() => {
    if (waitMs === undefined || waitMs <= 0) return undefined;
    const timer = setTimeout(() => setWaiting(false), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);
  return (
    <button type="button" className="summary-button" disabled={waiting} onClick={onTryAgain}>
      {SUMMARY_COPY.tryAgain}
    </button>
  );
}

/** The latest attempt's outcome when it is not a draft: one fixed sentence and the right next step; it never holds text from the provider. */
export function OutcomeCard({ outcome, sourceId, onTryAgain, onReturn }: OutcomeCardProps) {
  const words = wordsOf(outcome, sourceId);
  return (
    <section className="summary-outcome" aria-labelledby="summary-outcome-title">
      {words.icon === undefined ? null : <Icon kind={words.icon} />}
      <h3 id="summary-outcome-title" tabIndex={-1} data-summary-focus="title">
        {words.title}
      </h3>
      {words.figure === undefined ? null : <p className="summary-figure">{words.figure}</p>}
      <p>{words.text}</p>
      {outcome.kind === 'unsupported' || outcome.kind === 'too-large' ? <p className="summary-note">{SUMMARY_COPY.graphUnchanged}</p> : null}
      {outcome.kind === 'unsupported' ? (
        <>
          <CoverageBox retrieval={outcome.response.coverage.retrieval} summary={outcome.response.coverage.summary} />
          <Disclosure sent={outcome.response.sent} calls={outcome.response.calls} />
        </>
      ) : null}
      <div className="summary-actions">
        {words.action === 'return' || outcome.kind === 'unsupported' ? (
          <button type="button" className="summary-button" onClick={onReturn}>
            {SUMMARY_COPY.returnToGraph}
          </button>
        ) : null}
        {outcome.kind === 'unsupported' ? (
          <button type="button" className="summary-button summary-button-outline" onClick={onTryAgain}>
            {SUMMARY_COPY.regenerate}
          </button>
        ) : null}
        {words.action === 'try-again' ? <TryAgain waitMs={words.waitMs} onTryAgain={onTryAgain} /> : null}
      </div>
    </section>
  );
}
