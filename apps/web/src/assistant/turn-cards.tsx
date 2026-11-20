import { useEffect, useId, useState } from 'react';
import { ASSISTANT_CHOICE_INVALID_SENTENCE, ASSISTANT_LIMIT_SENTENCES, type AssistantLimit, type AssistantRead } from '@neburyx/contracts';
import { AnswerCard, HeavyCard } from '../ask/answer-card.js';
import { hintOf, humanize } from '../ask/text.js';
import { askFailureWords, isContinueInvalid } from '../ask/ask-failure.js';
import { isAssistantOff } from './failure-kinds.js';
import { rateLimitedSentence } from '../patterns/failure-words.js';
import { ASSISTANT_COPY, unavailableSentence } from './copy.js';
import { ConfirmationCard } from './confirmation-card.js';
import { ReadSteps } from './read-steps.js';
import type { Failure, Turn } from './assistant-session.js';
import { ClarificationCard } from './clarification-card.js';
import { FollowUps } from './follow-ups.js';
import { ViewAnswerCard } from './view-answer-card.js';
import { RefusalCard } from './refusal-card.js';

export interface TurnActions {
  readonly sourceId: string;
  readonly canAdd: boolean;
  retry(turnId: number): void;
  continueRun(turnId: number): void;
  askAgain(turnId: number): void;
  addToGraph(turnId: number): void;
  cancelClarification(turnId: number): void;
  pickCandidate(turnId: number, index: number): void;
  pressFollowUp(turnId: number, index: number): void;
  decide(turnId: number, decision: 'confirm' | 'skip'): void;
  cancelWaiting(turnId: number): void;
  readonly followUpsTurn: number | undefined;
  readonly busy: boolean;
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

function failureView(failure: Failure, sourceId: string, afterDecision = false): FailureView {
  switch (failure.kind) {
    case 'unavailable': {
      // a decision that began to read has used its confirmation: sending it again can only be refused, so the way on is the message again
      if (afterDecision && failure.readStarted) return { title: ASSISTANT_COPY.serviceTitle, text: unavailableSentence(failure.why, failure.readStarted), tone: 'problem', action: 'ask-again' };
      const text = failure.why === 'rate-limit' && failure.retryAfterSeconds !== undefined ? `${unavailableSentence(failure.why, failure.readStarted)} ${rateLimitedSentence(failure.retryAfterSeconds)}` : unavailableSentence(failure.why, failure.readStarted);
      return { title: ASSISTANT_COPY.serviceTitle, text, tone: 'problem', action: 'try-again', ...(failure.until === undefined ? {} : { until: failure.until }) };
    }
    case 'too-large':
      return { title: ASSISTANT_COPY.tooLargeTitle, text: failure.sentence, tone: 'caution', action: 'none' };
    case 'confirmation-invalid':
      return { title: ASSISTANT_COPY.confirmationInvalidTitle, text: failure.sentence, tone: 'caution', action: 'ask-again' };
    case 'continue-invalid':
      return { title: ASSISTANT_COPY.continueInvalidTitle, text: ASSISTANT_COPY.continueInvalid, tone: 'caution', action: 'ask-again' };
    case 'choice-invalid':
      return { title: ASSISTANT_COPY.choiceInvalidTitle, text: ASSISTANT_CHOICE_INVALID_SENTENCE, tone: 'caution', action: 'ask-again' };
    case 'follow-up-invalid':
      return { title: ASSISTANT_COPY.followUpInvalidTitle, text: ASSISTANT_COPY.followUpInvalid, tone: 'caution', action: 'none' };
    case 'summary-invalid':
      return { title: ASSISTANT_COPY.summaryInvalidTitle, text: failure.sentence, tone: 'caution', action: 'none' };
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

function FailureCard({ failure, turnId, actions, afterDecision = false }: { readonly failure: Failure; readonly turnId: number; readonly actions: TurnActions; readonly afterDecision?: boolean }) {
  const titleId = useId();
  const view = failureView(failure, actions.sourceId, afterDecision);
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

function StepsAndCoverage({ reads, coverage }: { readonly reads: readonly AssistantRead[] | undefined; readonly coverage: string | undefined }) {
  return (
    <>
      {reads === undefined ? null : <ReadSteps reads={reads} />}
      {coverage === undefined ? null : (
        <div className="assistant-coverage">
          <p>{ASSISTANT_COPY.coverage}</p>
          <p>{coverage}</p>
        </div>
      )}
    </>
  );
}

/** The stop of a limit: the card titled by the limit with its fixed sentence, and under it the line of what to do; it has the focus when it is the whole turn. */
function LimitCard({ limit, sentence, focus = false }: { readonly limit: AssistantLimit; readonly sentence: string; readonly focus?: boolean }) {
  const titleId = useId();
  return (
    <>
      <section className="assistant-limit" aria-labelledby={titleId}>
        <h3 id={titleId} tabIndex={-1} {...(focus ? { 'data-ask-focus': 'title' } : {})}>
          {ASSISTANT_COPY.limitTitles[limit]}
        </h3>
        <p>{sentence}</p>
      </section>
      <p className="assistant-limit-note">{limit === 'steps' ? ASSISTANT_COPY.limitNoteReads : ASSISTANT_COPY.limitNoteOther}</p>
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
    case 'waiting':
      return <ConfirmationCard waiting={outcome.waiting} onConfirm={() => actions.decide(turn.id, 'confirm')} onSkip={() => actions.decide(turn.id, 'skip')} onCancel={() => actions.cancelWaiting(turn.id)} />;
    case 'waiting-closed':
      return (
        <>
          <ReadSteps reads={outcome.reads} open />
          <p className="ask-note">{ASSISTANT_COPY.waitingClosed}</p>
        </>
      );
    case 'limit':
      return (
        <>
          <ReadSteps reads={outcome.reads} open />
          <LimitCard limit={outcome.limit} sentence={ASSISTANT_LIMIT_SENTENCES[outcome.limit]} focus />
        </>
      );
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
          <StepsAndCoverage reads={outcome.reads} coverage={outcome.coverage} />
          {outcome.stoppedAt === undefined ? null : <LimitCard limit={outcome.stoppedAt} sentence={ASSISTANT_LIMIT_SENTENCES[outcome.stoppedAt]} />}
          {actions.followUpsTurn === turn.id ? <FollowUps followUps={outcome.followUps} disabled={actions.busy} onPress={(index) => actions.pressFollowUp(turn.id, index)} /> : null}
        </>
      );
    case 'view-answer':
      return (
        <>
          <ViewAnswerCard answer={outcome.answer} entries={outcome.entries} />
          {'stoppedAt' in outcome.answer && outcome.answer.stoppedAt !== undefined ? <LimitCard limit={outcome.answer.stoppedAt} sentence={ASSISTANT_LIMIT_SENTENCES[outcome.answer.stoppedAt]} /> : null}
        </>
      );
    case 'clarification':
      return (
        <>
          <ClarificationCard question={outcome.question} candidates={outcome.candidates} onPick={(index) => actions.pickCandidate(turn.id, index)} onCancel={() => actions.cancelClarification(turn.id)} />
          {outcome.failed === undefined ? null : <FailureCard failure={outcome.failed.failure} turnId={turn.id} actions={actions} />}
        </>
      );
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
      return <FailureCard failure={outcome.failure} turnId={turn.id} actions={actions} afterDecision={outcome.retry.kind === 'decision'} />;
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
