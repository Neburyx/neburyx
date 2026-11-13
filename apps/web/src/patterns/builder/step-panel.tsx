import type { PatternProblem, SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { ConditionsField } from './conditions-field.js';
import { conditionsTab, EDITOR_COPY, LINK_COPY, stepSummary, windowTab } from './copy.js';
import { rowsOf, windowOf } from './conditions.js';
import { LinkTab } from './link-tab.js';
import { TabList, panelId, tabId } from './tabs.js';
import type { Action, StepDraft } from './model.js';
import { WindowField } from './window-field.js';

export type Part = 'link' | 'conditions' | 'window';
export const PARTS: readonly Part[] = ['link', 'conditions', 'window'];
export const isPart = (value: string): value is Part => PARTS.some((part) => part === value);

interface Props {
  readonly profile: SourceProfile;
  readonly step: StepDraft;
  readonly steps: readonly StepDraft[];
  readonly index: number;
  readonly previous: string | undefined;
  readonly mask: boolean;
  readonly nameOf: (type: string | undefined) => string;
  readonly dispatch: (action: Action) => void;
  readonly part: Part;
  readonly onPart: (part: Part) => void;
  readonly onRemove: () => void;
  readonly problems: readonly PatternProblem[];
  readonly rowProblems: ReadonlyMap<number, readonly PatternProblem[]>;
  readonly windowProblems: readonly PatternProblem[];
  /** What the mapping no longer has in this step, said in words, when the editor was opened from a saved pattern. */
  readonly unplaced: readonly string[];
}

const windowLabel = (step: StepDraft): string => {
  const window = windowOf(step);
  if (window.kind === 'none') return windowTab(undefined);
  return window.kind === 'days' ? `Window · ${window.text.trim() === '' ? '…' : `${window.text.trim()} d`}` : 'Window · dates';
};

/** One step, as the panel under the step tabs: its summary, Remove step and the three parts, Link, Conditions and Window. */
export function StepPanel({ profile, step, steps, index, previous, mask, nameOf, dispatch, part, onPart, onRemove, problems, rowProblems, windowProblems, unplaced }: Props) {
  const number = index + 1;
  const prefix = `step-${index}`;
  return (
    <div role="tabpanel" id={panelId('pattern-steps', `step-${index}`)} aria-labelledby={tabId('pattern-steps', `step-${index}`)} className="pattern-step-panel">
      <div className="pattern-step-head">
        <div>
          <p className="pattern-step-title">{`Step ${number}`}</p>
          <p className="pattern-step-summary">{stepSummary(step.relationshipTypes, step.arrivesAt === undefined ? undefined : nameOf(step.arrivesAt))}</p>
        </div>
        <button type="button" className="pattern-danger" aria-label={`${EDITOR_COPY.remove} ${number}`} onClick={onRemove}>
          {EDITOR_COPY.remove}
        </button>
      </div>
      {unplaced.map((text) => (
        <p key={text} className="search-panel-note" role="status">
          {text}
        </p>
      ))}
      <TabList
        label={`Parts of step ${number}`}
        idPrefix={prefix}
        selected={part}
        onSelect={(id) => isPart(id) && onPart(id)}
        tabs={[
          { id: 'link', label: LINK_COPY.link },
          { id: 'conditions', label: conditionsTab(rowsOf(step).length) },
          { id: 'window', label: windowLabel(step) },
        ]}
        className="pattern-parts"
      />
      <div role="tabpanel" id={panelId(prefix, part)} aria-labelledby={tabId(prefix, part)} className="pattern-part">
        {part === 'link' ? <LinkTab profile={profile} step={step} index={index} previous={previous} nameOf={nameOf} dispatch={dispatch} problems={problems} /> : null}
        {part === 'conditions' ? (
          <>
            <ConditionsField profile={profile} step={step} steps={steps} index={index} previous={previous} mask={mask} nodeName={nameOf(step.arrivesAt)} dispatch={dispatch} rowProblems={rowProblems} />
            {problems.map((found, place) => (
              <p className="patterns-error" key={`${found.code}-${place}`}>
                {problemText(found)}
              </p>
            ))}
          </>
        ) : null}
        {part === 'window' ? <WindowField profile={profile} step={step} index={index} previous={previous} dispatch={dispatch} problems={windowProblems} /> : null}
      </div>
    </div>
  );
}
