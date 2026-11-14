import { useEffect, useRef, useState } from 'react';
import type { ApiFailure } from '../api/client.js';
import { askFailureWords, isContinueInvalid } from './ask-failure.js';
import { AnswerCard, countSpoken, HeavyCard } from './answer-card.js';
import { ASK_COPY, CANCELLED_TEXT, FAILURE_TITLES, limitSpoken, limitText } from './copy.js';
import { RefusalCard } from './refusal-card.js';
import { resultView } from './result-model.js';
import type { Answered } from './ask-session.js';
import { codePointsOf, useAsk } from './use-ask.js';
import { ASK_QUESTION_MAX_CODE_POINTS } from '@neburyx/contracts';

const SERVICE_CODES: ReadonlySet<string> = new Set(['NETWORK_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'SOURCE_BUSY', 'QUERY_TIMEOUT', 'RATE_LIMITED', 'ASK_UNSUPPORTED']);

const answeredWords = (answer: Answered): string => {
  const fact = resultView(answer.result).count;
  return fact === undefined ? ASK_COPY.ready : `${ASK_COPY.ready}, ${countSpoken(fact)}`;
};

const failureTitle = (failure: ApiFailure): string => (failure.code === 'AUDIT_UNAVAILABLE' ? FAILURE_TITLES.audit : isContinueInvalid(failure) ? FAILURE_TITLES.continue : SERVICE_CODES.has(failure.code) ? FAILURE_TITLES.service : FAILURE_TITLES.other);

/** Try again, held back for the wait a rate limit asks for. */
function TryAgain({ waitMs, onRetry }: { readonly waitMs: number | undefined; readonly onRetry: () => void }) {
  const [waiting, setWaiting] = useState(waitMs !== undefined && waitMs > 0);
  useEffect(() => {
    if (waitMs === undefined || waitMs <= 0) return undefined;
    const timer = setTimeout(() => setWaiting(false), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);
  return (
    <button type="button" className="ask-continue" disabled={waiting} onClick={onRetry}>
      {ASK_COPY.tryAgain}
    </button>
  );
}

/** The header's Ask control, to give the focus back to when the panel is closed from inside. */
function focusAskControl(): void {
  const controls = [...document.querySelectorAll<HTMLElement>('.header-ai')];
  controls.find((control) => control.textContent?.trim().startsWith(ASK_COPY.title))?.focus();
}

function Sparkle() {
  return (
    <svg aria-hidden="true" className="ask-sparkle" viewBox="0 0 12 12" fill="currentColor">
      <path d="M5 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M9.5 7.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L7.5 9.5 9 9z" />
    </svg>
  );
}

/** The Ask panel: the question on top, and below it whatever the last question gave. */
export function AskPanel({ onClose }: { readonly onClose: () => void }) {
  const model = useAsk(() => {
    onClose();
    focusAskControl();
  });
  const { stage } = model.state;
  const field = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = model.focus.target;
    if (target === 'field') field.current?.focus();
    else if (target !== undefined) body.current?.querySelector<HTMLElement>(`[data-ask-focus="${target}"]`)?.focus();
  }, [model.focus]);

  const used = codePointsOf(model.state.question);
  const atLimit = used >= ASK_QUESTION_MAX_CODE_POINTS;
  const asking = stage.kind === 'asking';
  const announced = asking
    ? stage.call === 'continue'
      ? ASK_COPY.continuing
      : ASK_COPY.asking
    : stage.kind === 'answered'
      ? answeredWords(stage.answer)
      : stage.kind === 'heavy'
        ? ASK_COPY.stoppedSpoken
        : stage.kind === 'cancelled'
          ? CANCELLED_TEXT
          : stage.kind === 'masking-cleared'
            ? ASK_COPY.maskingCleared
            : '';
  const words = stage.kind === 'failed' ? askFailureWords(stage.failure, model.sourceId ?? '') : undefined;

  return (
    <div
      className="ask-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        model.escape();
      }}
    >
      <header className="ask-head">
        <Sparkle />
        <div className="ask-head-text">
          <h2 id="ask-panel-title">{ASK_COPY.title}</h2>
          <p>{ASK_COPY.subtitle}</p>
        </div>
        <button type="button" className="ask-close" aria-label={ASK_COPY.close} onClick={model.close}>
          ×
        </button>
      </header>
      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!asking) model.send();
        }}
      >
        <label htmlFor="ask-question">{ASK_COPY.fieldLabel}</label>
        <textarea
          id="ask-question"
          ref={field}
          rows={3}
          value={model.state.question}
          readOnly={asking}
          placeholder={ASK_COPY.placeholder}
          aria-describedby="ask-counter ask-keys"
          onChange={(event) => model.setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!asking) model.send();
            }
          }}
        />
        <div className="ask-form-row">
          <span id="ask-counter" className={atLimit ? 'ask-counter ask-counter-limit' : 'ask-counter'} aria-label={limitSpoken(used)}>
            {limitText(used)}
          </span>
          {asking ? (
            <button type="button" className="ask-send ask-send-cancel" onClick={model.cancel}>
              {ASK_COPY.cancel}
            </button>
          ) : (
            <button type="submit" className="ask-send" disabled={!model.canSend}>
              {ASK_COPY.send} <span aria-hidden="true">▸</span>
            </button>
          )}
        </div>
        <p id="ask-keys" className="ask-keys">
          {ASK_COPY.keys}
        </p>
        {atLimit ? <p className="ask-note ask-limit">{ASK_COPY.limitReached}</p> : null}
        {model.sourceChanged ? <p className="ask-note">{ASK_COPY.sourceChanged}</p> : null}
      </form>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </p>
      <div className="ask-body" ref={body}>
        {stage.kind === 'idle' ? <p className="ask-intro">{ASK_COPY.intro}</p> : null}
        {asking ? (
          <section className="ask-asking" aria-label={ASK_COPY.asking}>
            <p className="ask-asking-title">{stage.call === 'continue' ? ASK_COPY.continuing : ASK_COPY.asking}</p>
            <div className="ask-progress" aria-hidden="true">
              <span />
            </div>
            <p>{ASK_COPY.askingBody}</p>
            <p className="ask-note">{ASK_COPY.askingNote}</p>
          </section>
        ) : null}
        {stage.kind === 'answered' ? <AnswerCard answer={stage.answer} added={stage.added} canAdd={model.canAdd} onAdd={model.addToGraph} /> : null}
        {stage.kind === 'heavy' ? <HeavyCard answer={stage.answer} onContinue={model.continueRun} /> : null}
        {stage.kind === 'refused' ? <RefusalCard refused={stage.refused} question={model.state.asked} /> : null}
        {stage.kind === 'failed' && words !== undefined ? (
          <section className={isContinueInvalid(stage.failure) ? 'ask-failure ask-failure-caution' : 'ask-failure'} aria-labelledby="ask-failure-title" role="alert">
            <h3 id="ask-failure-title" tabIndex={-1} data-ask-focus="failure">
              {failureTitle(stage.failure)}
            </h3>
            <p>{words.text}</p>
            {isContinueInvalid(stage.failure) ? (
              <button type="button" className="ask-continue" onClick={model.askAgain}>
                {ASK_COPY.askAgain}
              </button>
            ) : words.action === 'try-again' ? (
              <TryAgain waitMs={words.waitMs} onRetry={model.retry} />
            ) : null}
          </section>
        ) : null}
        {stage.kind === 'cancelled' ? (
          <section className="ask-cancelled" aria-labelledby="ask-cancelled-title">
            <h3 id="ask-cancelled-title" tabIndex={-1} data-ask-focus="note">
              {FAILURE_TITLES.cancelled}
            </h3>
            <p>{CANCELLED_TEXT}</p>
          </section>
        ) : null}
        {stage.kind === 'masking-cleared' ? (
          <p className="ask-note" tabIndex={-1} data-ask-focus="note">
            {ASK_COPY.maskingCleared}
          </p>
        ) : null}
      </div>
    </div>
  );
}
