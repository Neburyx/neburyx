import { useEffect, useId, useState } from 'react';
import { AnswerCard, HeavyCard } from '../ask/answer-card.js';
import { hintOf, humanize } from '../ask/text.js';
import { askFailureWords, isContinueInvalid } from '../ask/ask-failure.js';
import { isAssistantOff } from './failure-kinds.js';
import { rateLimitedSentence } from '../patterns/failure-words.js';
import { ASSISTANT_COPY, unavailableSentence } from './copy.js';
import type { Failure, Step, Turn } from './assistant-session.js';
import { ViewAnswerCard } from './view-answer-card.js';
import { RefusalCard } from './refusal-card.js';

export interface TurnActions {
  readonly sourceId: string;
  readonly canAdd: boolean;
  retry(turnId: number): void;
  continueRun(turnId: number): void;
  askAgain(turnId: number): void;
  addToGraph(turnId: number): void;
}

/** Try again, held back until the deadline of the wait a rate limit asks for; a card shown again counts the time left, not the whole wait. */
function TryAgain({ until, onRetry }: { readonly until: number | undefined; readonly onRetry: () => void }) {
  const [waiting, setWaiting] = useState(until !== undefined && until > Date.now());
  useEffect(() => {
    if (until === undefined || until <= Date.now()) {
      setWaiting(false);
      return undefined;
    }
    setWaiting(true);
    const timer = setTimeout(() => setWaiting(false), until - Date.now());
    return () => clearTimeout(timer);
  }, [until]);
  return (
    <button type="button" className="ask-continue" disabled={waiting} onClick={onRetry}>
      {ASSISTANT_COPY.tryAgain}
    </button>
  );
}

interface FailureView {
  readonly title: string;
  readonly text: string;
  readonly tone: 'problem' | 'caution';
  readonly action: 'try-again' | 'ask-again' | 'none';
  readonly until?: number;
}

function failureView(failure: Failure, sourceId: string): FailureView {
  switch (failure.kind) {
    case 'unavailable': {
      const text = failure.why === 'rate-limit' && failure.retryAfterSeconds !== undefined ? `${unavailableSentence(failure.why, failure.readStarted)} ${rateLimitedSentence(failure.retryAfterSeconds)}` : unavailableSentence(failure.why, failure.readStarted);
      return { title: ASSISTANT_COPY.serviceTitle, text, tone: 'problem', action: 'try-again', ...(failure.until === undefined ? {} : { until: failure.until }) };
    }
    case 'too-large':
      return { title: ASSISTANT_COPY.tooLargeTitle, text: failure.sentence, tone: 'caution', action: 'none' };
    case 'continue-invalid':
      return { title: ASSISTANT_COPY.continueInvalidTitle, text: ASSISTANT_COPY.continueInvalid, tone: 'caution', action: 'ask-again' };
    case 'request': {
      if (isContinueInvalid(failure.failure)) return { title: ASSISTANT_COPY.continueInvalidTitle, text: ASSISTANT_COPY.continueInvalid, tone: 'caution', action: 'ask-again' };
      if (isAssistantOff(failure.failure)) return { title: ASSISTANT_COPY.serviceTitle, text: ASSISTANT_COPY.notAvailableNow, tone: 'caution', action: 'none' };
      const words = askFailureWords(failure.failure, sourceId);
      return { title: ASSISTANT_COPY.serviceTitle, text: words.text, tone: 'problem', action: words.action === 'try-again' ? 'try-again' : 'none', ...(failure.until === undefined ? {} : { until: failure.until }) };
    }
    default: {
      const unreachable: never = failure;
      return unreachable;
    }
  }
}

function FailureCard({ failure, turnId, actions }: { readonly failure: Failure; readonly turnId: number; readonly actions: TurnActions }) {
  const titleId = useId();
  const view = failureView(failure, actions.sourceId);
  return (
    <section className={view.tone === 'caution' ? 'ask-failure ask-failure-caution' : 'ask-failure'} aria-labelledby={titleId} role="alert">
      <h3 id={titleId} tabIndex={-1} data-ask-focus="failure">
        {view.title}
      </h3>
      <p>{view.text}</p>
      {view.action === 'try-again' ? <TryAgain until={view.until} onRetry={() => actions.retry(turnId)} /> : null}
      {view.action === 'ask-again' ? (
        <button type="button" className="ask-continue" onClick={() => actions.askAgain(turnId)}>
          {ASSISTANT_COPY.askAgain}
        </button>
      ) : null}
    </section>
  );
}

function StepsAndCoverage({ step, coverage }: { readonly step: Step | undefined; readonly coverage: string | undefined }) {
  return (
    <>
      {step === undefined ? null : (
        <details className="assistant-steps">
          <summary>{ASSISTANT_COPY.steps} · 1</summary>
          <p>{`Ran ${humanize(step.intent)} · ${step.rows.toLocaleString('en-US')} ${step.rows === 1 ? 'row' : 'rows'} · ${step.outcome}`}</p>
        </details>
      )}
      {coverage === undefined ? null : (
        <div className="assistant-coverage">
          <p>{ASSISTANT_COPY.coverage}</p>
          <p>{coverage}</p>
        </div>
      )}
    </>
  );
}

function Tag({ text }: { readonly text: string }) {
  return <p className="assistant-tag">{text}</p>;
}

function Outcome({ turn, actions }: { readonly turn: Turn; readonly actions: TurnActions }) {
  const { outcome } = turn;
  const titleId = useId();
  switch (outcome.kind) {
    case 'pending':
      return (
        <section className="ask-asking" aria-label={outcome.call === 'continue' ? ASSISTANT_COPY.continuing : ASSISTANT_COPY.working}>
          <p className="ask-asking-title">{outcome.call === 'continue' ? ASSISTANT_COPY.continuing : ASSISTANT_COPY.working}</p>
          <div className="ask-progress" aria-hidden="true">
            <span />
          </div>
          <p>{ASSISTANT_COPY.workingBody}</p>
        </section>
      );
    case 'cancelled':
      return (
        <section className="ask-cancelled" aria-labelledby={titleId}>
          <h3 id={titleId}>{ASSISTANT_COPY.cancelledTitle}</h3>
          <p>{ASSISTANT_COPY.cancelledBody}</p>
        </section>
      );
    case 'refuse':
      return <RefusalCard sentence={outcome.sentence} />;
    case 'not-answered':
      return (
        <section className="assistant-not-answered" aria-labelledby={titleId}>
          <Tag text={ASSISTANT_COPY.routeView} />
          <h3 id={titleId} tabIndex={-1} data-ask-focus="title">
            {ASSISTANT_COPY.notAnswered}
          </h3>
          <p>{outcome.sentence}</p>
        </section>
      );
    case 'answered':
      return (
        <>
          <Tag text={ASSISTANT_COPY.routeAsk} />
          <AnswerCard answer={outcome.answer} added={outcome.added} canAdd={actions.canAdd} onAdd={() => actions.addToGraph(turn.id)} />
          <StepsAndCoverage step={outcome.step} coverage={outcome.coverage} />
        </>
      );
    case 'view-answer':
      return <ViewAnswerCard answer={outcome.answer} entries={outcome.entries} />;
    case 'ask-refused':
      return <RefusalCard sentence={outcome.refused.sentence} hint={hintOf(outcome.refused.cause)} />;
    case 'heavy':
      return (
        <>
          <Tag text={ASSISTANT_COPY.routeAsk} />
          <HeavyCard answer={outcome.answer} onContinue={() => actions.continueRun(turn.id)} body={ASSISTANT_COPY.heavyBody} note={ASSISTANT_COPY.heavyNote} />
        </>
      );
    case 'failed':
      return <FailureCard failure={outcome.failure} turnId={turn.id} actions={actions} />;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function TurnView({ turn, actions }: { readonly turn: Turn; readonly actions: TurnActions }) {
  return (
    <li className="assistant-turn" data-assistant-turn={turn.id}>
      <p className="assistant-message">
        <span className="visually-hidden">{ASSISTANT_COPY.you}: </span>
        {turn.message}
      </p>
      <Outcome turn={turn} actions={actions} />
    </li>
  );
}
