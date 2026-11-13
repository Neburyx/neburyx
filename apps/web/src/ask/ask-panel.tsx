import { useId, type KeyboardEvent } from 'react';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { planOut } from './plan-activity.js';
import { BlockedCard, ClarificationCard, PreviewCard, RefusalCard } from './cards.js';
import { PlanCard } from './plan-card.js';
import { ASK_COPY, notSentText } from './copy.js';
import { QuestionField } from './question-field.js';
import { useAsk, type AskModel } from './use-ask.js';
import { focusAskControl } from './ask-binder-focus.js';

/** The words of the status region: what the panel is waiting for or what it holds, said once. */
export function statusOf(model: AskModel): string {
  if (model.busy === 'asking') return ASK_COPY.asking;
  if (model.busy === 'sending') return ASK_COPY.sending;
  if (model.failure !== undefined) return model.failure.words.text;
  if (model.sent !== undefined) return model.sent;
  if (model.notice !== undefined) return model.notice;
  if (model.card?.kind === 'blocked') return notSentText(model.card.tokens.length);
  if (model.card?.kind === 'clarification') return ASK_COPY.awaiting;
  if (model.card?.kind === 'preview' && model.card.changed) return ASK_COPY.changedNote;
  return '';
}

export function AskPanel() {
  const panel = useAsk();
  const state = useClientState();
  const { model } = panel;
  const hintId = useId();
  const statusId = useId();
  // a question that is out, and a plan that is being run, edited or cancelled, cannot be taken back, so the panel stays as it is until the answer
  const planIsOut = useStoreSelector(planOut, (out) => out);
  const sending = model.busy === 'sending' || planIsOut;
  const blocked = model.card?.kind === 'blocked' ? model.card.tokens : [];
  const close = (): void => {
    if (sending) return;
    state.presentation.setAskOpen(false);
    focusAskControl();
  };
  const escape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    if (sending) return;
    if (model.picker !== undefined) panel.closePicker();
    else if (model.card !== undefined) panel.cancelClarification();
    else close();
  };
  const note = panel.sourceId === null ? ASK_COPY.noInvestigation : model.fieldNote;
  return (
    <div className="ask-panel" onKeyDown={escape}>
      <div className="ask-heading">
        <h2 className="ask-title">{ASK_COPY.title}</h2>
        <button type="button" className="ask-close" aria-label={ASK_COPY.close} disabled={sending} onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <QuestionField
        text={model.text}
        blocked={blocked}
        disabled={sending || panel.sourceId === null}
        focus={model.focus}
        describedBy={`${hintId} ${statusId}`}
        invalid={model.fieldNote !== undefined}
        onText={panel.setText}
        onSubmit={panel.preview}
      />
      <p id={hintId} className="ask-hint">
        {ASK_COPY.hint}
      </p>
      {note === undefined ? null : <p className="ask-note ask-field-note">{note}</p>}
      <div className="ask-actions">
        <button type="button" className="ask-primary" disabled={sending || model.busy === 'asking' || panel.sourceId === null} onClick={panel.preview}>
          {ASK_COPY.preview}
        </button>
      </div>
      <div id={statusId} role="status" aria-live="polite" className="ask-status">
        {statusOf(model)}
      </div>
      {model.failure?.retry !== undefined ? (
        <button type="button" className="ask-secondary" onClick={panel.retry}>
          {ASK_COPY.retry}
        </button>
      ) : null}
      {model.card?.kind === 'preview' ? <PreviewCard key={model.cardId} card={model.card} panel={panel} /> : null}
      {model.plan?.kind === 'unsupported' ? <RefusalCard key={`refusal-${model.cardId}`} question={model.text} family={model.plan.family} reason={model.plan.reason} /> : null}
      {model.plan?.kind === 'plan' && model.planId !== undefined && model.expiresAt !== undefined ? <PlanCard ask={panel} plan={model.plan} planId={model.planId} expiresAt={model.expiresAt} /> : null}
      {model.card?.kind === 'blocked' ? <BlockedCard key={model.cardId} tokens={model.card.tokens} panel={panel} /> : null}
      {model.card?.kind === 'clarification' ? <ClarificationCard key={model.cardId} clarification={model.card.clarification} panel={panel} /> : null}
    </div>
  );
}
