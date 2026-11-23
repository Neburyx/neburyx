import { useEffect, useRef } from 'react';
import { useClientState } from '../state/context.js';
import { usePanelSize } from '../workspace/panel-host.js';
import { useAiAvailabilityWhenProvided } from '../shell/shell-data.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE, ASSISTANT_PANEL_WIDTH } from './panel-layout.js';
import { ASSISTANT_COPY, hintText, tooLongText, TOO_LONG_NOTE, wordsSpoken, wordsText } from './copy.js';
import { MaskingCard, NewThreadCard, StandingNote } from './thread-notices.js';
import { StoredTurns } from './stored-turns.js';
import { useStoredThread } from './stored-thread.js';
import { SummaryContext } from './summary-context.js';
import { TurnView, stepSentenceOf } from './turn-cards.js';
import { useAssistant } from './use-assistant.js';

function Chat() {
  return (
    <svg aria-hidden="true" className="ask-sparkle" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 2h9v6h-5L3 10.5V8H1.5z" />
    </svg>
  );
}

function WideIcon() {
  return (
    <svg aria-hidden="true" className="assistant-wide-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" />
    </svg>
  );
}

function WideButton() {
  const { presentation } = useClientState();
  const size = usePanelSize();
  if (size === undefined) return null;
  const canWiden = size.limits.max > ASSISTANT_PANEL_WIDTH;
  const wide = canWiden && size.width >= size.limits.max;
  const toggle = (): void => (wide ? presentation.clearPanelSize(ASSISTANT_PANEL_ID) : presentation.setPanelSize(ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDE_SIZE));
  return (
    <button type="button" className="assistant-wide" aria-label={wide ? ASSISTANT_COPY.normalWidth : ASSISTANT_COPY.wide} aria-pressed={wide} disabled={!canWiden} onClick={toggle}>
      <WideIcon />
    </button>
  );
}

function focusAssistantControl(): void {
  const controls = [...document.querySelectorAll<HTMLElement>('.header-ai')];
  controls.find((control) => control.textContent?.trim().startsWith(ASSISTANT_COPY.title))?.focus();
}

function focusInside(element: HTMLElement | null | undefined, thread: HTMLElement | null, turn?: HTMLElement | null): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  if (!thread || !turn || !thread.contains(turn)) return;
  thread.scrollTop += turn.getBoundingClientRect().top - thread.getBoundingClientRect().top;
}

function Intro() {
  return (
    <div className="assistant-intro">
      <h3>{ASSISTANT_COPY.introTitle}</h3>
      <p>{ASSISTANT_COPY.intro}</p>
      <div className="assistant-examples">
        <p>{ASSISTANT_COPY.forExample}</p>
        <ul>
          {ASSISTANT_COPY.examples.map((example) => (
            <li key={example}>{example}</li>
          ))}
        </ul>
      </div>
      <p className="ask-note">{ASSISTANT_COPY.introNote}</p>
    </div>
  );
}

function NotAvailable() {
  return (
    <div className="assistant-unavailable">
      <section className="ask-failure ask-failure-caution">
        <h3>{ASSISTANT_COPY.unavailableTitle}</h3>
        <p>{ASSISTANT_COPY.unavailableBody}</p>
      </section>
      <p className="ask-note">{ASSISTANT_COPY.unavailableNote}</p>
      <p className="ask-note">{ASSISTANT_COPY.unavailableManual}</p>
    </div>
  );
}

export function AssistantPanel({ onClose }: { readonly onClose: () => void }) {
  const model = useAssistant();
  const availability = useAiAvailabilityWhenProvided('assistant');
  const stored = useStoredThread(availability === 'available');
  const off = stored.kind === 'off';
  const available = availability === 'available' && !off;
  const unavailable = availability === 'unavailable' || off;
  const field = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { turns, notice, input, summary } = model.state;
  const storedTurns = stored.kind === 'ready' ? stored.thread.turns : [];
  const showNewThread = stored.kind === 'ready' && turns.length === 0 && storedTurns.length === 0 && stored.thread.previousThreadClearedAt !== null && notice?.kind !== 'masking-cleared' && notice?.kind !== 'access-lost';
  const pending = turns.some((turn) => turn.outcome.kind === 'pending');
  useEffect(() => {
    const thread = body.current;
    if (model.focus.target === 'input') focusInside(field.current, null);
    else {
      const turn = thread?.querySelector<HTMLElement>(`[data-assistant-turn="${model.focus.target}"]`);
      focusInside(turn?.querySelector<HTMLElement>('[data-ask-focus]'), thread, turn);
    }
  }, [model.focus]);
  useEffect(() => {
    if (model.canCancel) cancel.current?.focus();
  }, [model.canCancel]);
  const canSend = model.canSend && available;
  const limit = model.limit;
  // the one live region of the panel says the step in progress when the server reports one, and the waiting sentence until then
  const step = turns.flatMap((turn) => (turn.outcome.kind === 'pending' ? (turn.outcome.steps ?? []).slice(-1) : []))[0];
  const announced = pending ? (step === undefined ? ASSISTANT_COPY.working : stepSentenceOf(step)) : '';
  const close = (): void => {
    onClose();
    focusAssistantControl();
  };
  const tooLongNotice = notice?.kind === 'too-long' ? notice : model.tooLong && limit !== undefined ? { kind: 'too-long' as const, words: model.words, limit } : undefined;
  const actions = {
    sourceId: model.sourceId ?? '',
    canAdd: model.canAdd,
    retry: model.retry,
    continueRun: model.continueRun,
    askAgain: model.askAgain,
    addToGraph: model.addToGraph,
    cancelClarification: model.cancelClarification,
    pickCandidate: model.pickCandidate,
    pressFollowUp: model.pressFollowUp,
    decide: model.decide,
    cancelWaiting: model.cancelWaiting,
    followUpsTurn: model.followUpsTurn,
    busy: model.busy,
  };

  return (
    <div
      className="ask-panel assistant-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="ask-head">
        <Chat />
        <div className="ask-head-text">
          <h2>{ASSISTANT_COPY.title}</h2>
          <p>{model.title}</p>
        </div>
        <WideButton />
        <button type="button" className="ask-close" aria-label={ASSISTANT_COPY.close} onClick={close}>
          ×
        </button>
      </header>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </p>
      <div className="ask-body assistant-body" ref={body}>
        {unavailable ? <NotAvailable /> : showNewThread ? <NewThreadCard /> : null}
        {!unavailable && stored.kind === 'loading' ? <p className="ask-note" role="status">{ASSISTANT_COPY.storedLoading}</p> : null}
        {!unavailable && stored.kind === 'failed' ? <p className="ask-note" role="alert">{ASSISTANT_COPY.storedFailed}</p> : null}
        {!unavailable && storedTurns.length > 0 ? <StoredTurns turns={storedTurns} earlier={stored.kind === 'ready' ? stored.thread.earlierTurns : 0} /> : null}
        {!unavailable && summary !== undefined ? <SummaryContext summary={summary} /> : null}
        {unavailable || turns.length > 0 || storedTurns.length > 0 || showNewThread ? null : <Intro />}
        {!unavailable && turns.length > 0 ? (
          <ol className="assistant-thread" aria-label={ASSISTANT_COPY.thread}>
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} actions={actions} />
            ))}
          </ol>
        ) : null}
        {notice?.kind === 'access-lost' ? <p className="ask-note" role="alert">{ASSISTANT_COPY.accessLost}</p> : null}
        {notice?.kind === 'masking-cleared' ? <MaskingCard summary={notice.summary === true} /> : null}
        {model.viewTooLarge || notice?.kind === 'view-too-large' ? <p className="ask-note" role="alert">{ASSISTANT_COPY.viewTooLarge}</p> : null}
      </div>
      <form
        className="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) model.send();
        }}
      >
        {summary?.status === 'attached' && !unavailable ? (
          <p className="assistant-asking">
            <span className="summary-tag summary-tag-accent">{ASSISTANT_COPY.summaryAsking}</span>
            <button type="button" className="assistant-asking-remove" aria-label={ASSISTANT_COPY.summaryRemove} onClick={model.removeSummary}>
              ×
            </button>
          </p>
        ) : null}
        <label htmlFor="assistant-message" className="visually-hidden">
          {ASSISTANT_COPY.fieldLabel}
        </label>
        <textarea
          id="assistant-message"
          ref={field}
          rows={1}
          value={unavailable ? '' : input}
          readOnly={pending}
          aria-disabled={pending ? true : undefined}
          disabled={!available}
          className={tooLongNotice === undefined ? undefined : 'assistant-over'}
          placeholder={unavailable ? ASSISTANT_COPY.unavailableField : pending ? ASSISTANT_COPY.waitingPlaceholder : summary?.status === 'attached' ? ASSISTANT_COPY.summaryPlaceholder : ASSISTANT_COPY.placeholder}
          aria-invalid={tooLongNotice !== undefined}
          aria-describedby={unavailable ? "assistant-counter assistant-keys" : "assistant-counter assistant-keys assistant-standing"}
          onChange={(event) => model.setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) model.send();
            }
          }}
        />
        {tooLongNotice === undefined ? null : (
          <p className="ask-note assistant-over-text" role="alert">
            {tooLongText(tooLongNotice.words, tooLongNotice.limit)}
          </p>
        )}
        <div className="ask-form-row">
          <span id="assistant-counter" className={tooLongNotice === undefined ? 'ask-counter' : 'ask-counter ask-counter-limit'} aria-label={limit === undefined ? undefined : wordsSpoken(model.words, limit)}>
            {limit === undefined ? '' : wordsText(model.words, limit)}
          </span>
          {model.canCancel ? (
            <button key="cancel" ref={cancel} type="button" className="ask-send ask-send-cancel" onClick={model.cancel}>
              {ASSISTANT_COPY.cancel}
            </button>
          ) : (
            <button key="send" type="submit" className="ask-send" disabled={!canSend}>
              {ASSISTANT_COPY.send} <span aria-hidden="true">▸</span>
            </button>
          )}
        </div>
        <p id="assistant-keys" className={model.canCancel || unavailable || tooLongNotice !== undefined ? 'ask-keys' : 'ask-keys visually-hidden'}>
          {model.canCancel ? ASSISTANT_COPY.cancelHint : unavailable ? ASSISTANT_COPY.unavailableSend : tooLongNotice !== undefined ? TOO_LONG_NOTE : limit === undefined ? '' : hintText(limit)}
        </p>
        {unavailable ? null : <StandingNote />}
        {model.sourceChanged ? <p className="ask-note">{ASSISTANT_COPY.sourceChanged}</p> : null}
      </form>
    </div>
  );
}
