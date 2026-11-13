import { useEffect, useId, useRef } from 'react';
import type { AskPatternCard } from '@neburyx/contracts';
import { PLAN_COPY, ranText } from './plan-copy.js';
import { PlanEdit } from './plan-edit.js';
import { planView, type TemplatePlan } from './plan-model.js';
import { HeavyView, ResultView } from './plan-result.js';
import { usePlan, type PlanPanel } from './use-plan.js';
import type { AskPanel } from './use-ask.js';

/** The plan the server proposed, for the person to review: its template and typed parameters in words, and what can be done with it. Nothing runs until Run. */
export function PlanCard({ ask, plan, planId, expiresAt, patternsCut = false, patternCard }: { readonly ask: AskPanel; readonly plan: TemplatePlan; readonly planId: string; readonly expiresAt: string; readonly patternsCut?: boolean; readonly patternCard?: AskPatternCard | undefined }) {
  const panel = usePlan(ask, plan, planId, expiresAt);
  const titleId = useId();
  const drawn = useRef<HTMLElement>(null);
  const kind = panel.stage.kind;
  // a card takes the focus when it is drawn and again when it changes to another state, so the keyboard continues where the answer is
  useEffect(() => drawn.current?.focus(), [kind]);
  const { stage } = panel;
  return (
    <section
      className={`ask-card ask-plan ask-plan-${kind}`}
      aria-labelledby={titleId}
      tabIndex={-1}
      ref={drawn}
      onKeyDown={(event) => {
        // Escape leaves the edit and keeps the plan; in any other state it is the panel's own
        if (event.key !== 'Escape' || stage.kind !== 'editing') return;
        event.stopPropagation();
        event.preventDefault();
        if (!stage.saving) panel.back();
      }}
    >
      <h3 id={titleId} className="ask-card-title">
        {PLAN_COPY.title}
      </h3>
      {stage.kind === 'editing' ? <PlanEdit panel={panel} /> : <Review panel={panel} saved={plan.templateId === 'saved-pattern'} pattern={patternCard} />}
      {patternsCut && plan.templateId === 'saved-pattern' ? <p className="ask-note ask-plan-cut">{PLAN_COPY.patternsCut}</p> : null}
      {stage.kind === 'result' ? <ResultView panel={panel} /> : null}
      {stage.kind === 'heavy' ? <HeavyView panel={panel} /> : null}
      <p aria-live="polite" className="ask-plan-status">
        {stage.kind === 'result' ? ranText(stage.run.result.templateId, stage.seconds, stage.outcome) : panel.status}
      </p>
      {stage.kind === 'failed' ? <FailureActions panel={panel} /> : null}
    </section>
  );
}

function Review({ panel, saved, pattern }: { readonly panel: PlanPanel; readonly saved: boolean; readonly pattern: AskPatternCard | undefined }) {
  const { current, stage, profile } = panel;
  const view = planView(current.plan, { entityType: (type) => profile?.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type }, pattern);
  const spent = stage.kind === 'result' || stage.kind === 'cancelled' || stage.kind === 'failed' || stage.kind === 'heavy';
  const working = stage.kind === 'working';
  const noEditId = useId();
  return (
    <>
      <p className="ask-plan-template">
        <span className="ask-plan-name">{view.name}</span>
        {saved ? null : (
          <>
            {' '}
            <code className="ask-plan-id">{view.id}</code>
          </>
        )}
      </p>
      <dl className="ask-plan-lines">
        {view.lines.map((line) => (
          <div key={line.label} className="ask-plan-line">
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      <p className="ask-note">{PLAN_COPY.defaults}</p>
      <p className="ask-note ask-plan-readonly">{PLAN_COPY.readOnly}</p>
      {saved && !spent ? (
        <p id={noEditId} className="ask-note ask-plan-no-edit">
          {PLAN_COPY.savedNoEdit}
        </p>
      ) : null}
      {spent ? null : (
        <div className="ask-actions">
          <button type="button" className="ask-primary" disabled={working} onClick={panel.run}>
            {PLAN_COPY.run}
          </button>
          <button type="button" className="ask-secondary" disabled={working || saved} aria-describedby={saved ? noEditId : undefined} onClick={panel.edit}>
            {PLAN_COPY.edit}
          </button>
          {saved ? (
            <button type="button" className="ask-secondary" disabled={working} onClick={panel.askAgain}>
              {PLAN_COPY.askAgain}
            </button>
          ) : null}
          <button type="button" className="ask-secondary" disabled={working} onClick={panel.cancel}>
            {PLAN_COPY.cancel}
          </button>
        </div>
      )}
    </>
  );
}

function FailureActions({ panel }: { readonly panel: PlanPanel }) {
  const { stage } = panel;
  if (stage.kind !== 'failed') return null;
  const { action } = stage.words;
  return (
    <div className="ask-actions">
      {action === 'ask-again' ? (
        <button type="button" className="ask-primary" onClick={panel.askAgain}>
          {PLAN_COPY.askAgain}
        </button>
      ) : null}
      {action === 'run-again' ? (
        <button type="button" className="ask-primary" onClick={panel.runAgain}>
          {PLAN_COPY.runAgain}
        </button>
      ) : null}
      {action === 'try-again' ? (
        <button type="button" className="ask-primary" onClick={panel.retry}>
          {PLAN_COPY.tryAgain}
        </button>
      ) : null}
    </div>
  );
}
