import type { Count } from '@neburyx/contracts';
import { PLAN_COPY } from './plan-copy.js';
import { resultView } from './plan-result-model.js';
import { addedText } from '../patterns/copy.js';
import { degreeCountText } from '../workspace/degree-text.js';
import type { PlanPanel } from './use-plan.js';

/** The count of a result that has none of its own (an entity, an expansion): an exact one, so the words say only what was added and what the graph held. */
const NO_RESULT_COUNT: Count = { quality: 'exact', value: 0, scope: 'none' };

/** What a run gave: each count with its quality label, the notices it carries, and Add to graph when the result lists something to draw. */
export function ResultView({ panel }: { readonly panel: PlanPanel }) {
  const { stage } = panel;
  if (stage.kind !== 'result') return null;
  const view = resultView(stage.run.result);
  const count = stage.run.result.templateId === 'shared-attribute' || stage.run.result.templateId === 'linked-entities' ? (stage.run.result.result.status === 'ok' ? stage.run.result.result.count : undefined) : undefined;
  return (
    <div className="ask-plan-result">
      <dl className="ask-plan-lines">
        {view.lines.map((line) => (
          <div key={line.label} className="ask-plan-line">
            <dt>{line.label}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
      </dl>
      {view.notices.length === 0 ? null : (
        <ul className="ask-plan-notices">
          {view.notices.map((notice) => (
            <li key={notice} className="ask-note">
              {notice}
            </li>
          ))}
        </ul>
      )}
      {view.addable === undefined ? (
        <p className="ask-note">{PLAN_COPY.noAdd}</p>
      ) : stage.added === undefined ? (
        <div className="ask-actions">
          <button type="button" className="ask-primary" disabled={!panel.canAdd} onClick={panel.addToGraph}>
            {PLAN_COPY.addToGraph}
          </button>
        </div>
      ) : (
        <p className="ask-note" aria-live="polite">
          {addedText(stage.added, count ?? NO_RESULT_COUNT)}
        </p>
      )}
    </div>
  );
}

/** A run that would read more than the source allows without being asked: the estimate with its label, and Continue or Cancel. */
export function HeavyView({ panel }: { readonly panel: PlanPanel }) {
  const { stage } = panel;
  if (stage.kind !== 'heavy') return null;
  const result = stage.run.result;
  const estimate = result.templateId === 'shared-attribute' || result.templateId === 'linked-entities' || result.templateId === 'saved-pattern' ? (result.result.status === 'heavy' ? result.result : undefined) : undefined;
  return (
    <div className="ask-plan-heavy">
      {estimate === undefined ? null : (
        <dl className="ask-plan-lines">
          <div className="ask-plan-line">
            <dt>Estimate</dt>
            <dd>{degreeCountText(estimate.estimate)}</dd>
          </div>
          <div className="ask-plan-line">
            <dt>Threshold</dt>
            <dd>{estimate.threshold}</dd>
          </div>
        </dl>
      )}
      <p className="ask-note">{PLAN_COPY.heavyNote}</p>
      <div className="ask-actions">
        <button type="button" className="ask-primary" onClick={panel.continueRun}>
          {PLAN_COPY.continue}
        </button>
        <button type="button" className="ask-secondary" onClick={panel.cancel}>
          {PLAN_COPY.cancel}
        </button>
      </div>
    </div>
  );
}
