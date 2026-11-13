import { useEffect, useRef, type ReactNode } from 'react';
import { PATTERN_LIMITS, type PatternProblem, type SourceProfile } from '@neburyx/contracts';
import { failureView } from '../copy.js';
import type { ApiClient } from '../../api/client.js';
import { ARROW, checkFailureText, problemText } from '../copy.js';
import { BUILDER_COPY, CONDITIONS_COPY, DIRECTION_TEXT, blockText, noArrival, placeOf, stepTitle, stepsLine, tooManyTypes } from './copy.js';
import { DIRECTIONS, addStepBlock, arrivalTypes, isComplete, lastTypeOf, previousTypeOf, relationshipChoices, stepLimitOf, toDefinition, type Action, type BuilderState, type Direction, type StepDraft } from './model.js';
import { rowsOf } from './conditions.js';
import { ConditionsField } from './conditions-field.js';
import { WindowField } from './window-field.js';
import type { PatternDefinition } from '@neburyx/contracts';
import { usePatternCheck, type CheckState } from './use-check.js';

export type { CheckState };
export { CHECK_DEBOUNCE_MS } from './use-check.js';

export type ProfileView = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly profile: SourceProfile };

/** What the editor says of a saved pattern it was opened from, in words the panel has already chosen: the editor shows them and knows nothing of where they came from. */
export interface EditingView {
  readonly title: string;
  /** Lines under the title. */
  readonly notes: readonly string[];
  /** Reasons that have no step to sit beside. */
  readonly loose: readonly string[];
  /** Reasons that sit in a step's card, by the index of the step. */
  readonly stepNotes: ReadonlyMap<number, readonly string[]>;
}

/** Why a pattern cannot be saved or run yet, and what it starts from, handed to whatever the footer shows. */
export interface SaveContext {
  readonly anchor: { readonly entityType: string; readonly stableId: string } | undefined;
  /** Why nothing can be saved yet, in the order the person meets it, or nothing. */
  readonly block: string | undefined;
}

/** What the editor knows and the footer needs: the definition the draft makes, the check on it and where focus goes back to. */
export interface FooterState {
  readonly profile: SourceProfile;
  readonly definition: PatternDefinition | undefined;
  readonly anchorType: string | undefined;
  readonly check: CheckState;
  /** The definition the check's `valid` belongs to. */
  readonly validFor: string | undefined;
  readonly nameOf: (type: string | undefined) => string;
  /** Puts the focus on the editor's first choice. */
  readonly focusStart: () => void;
}

interface Props {
  readonly profile: ProfileView;
  readonly retryProfile: () => void;
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly maxHops: number | undefined;
  readonly state: BuilderState;
  readonly dispatch: (action: Action) => void;
  /** Leaves the editor for the list. */
  readonly onCancel: () => void;
  /** Opens the preview of the finished draft: the run lane's view, drawn by a later story; until then the run is under the editor. */
  readonly onPreview: (definition: PatternDefinition) => void;
  readonly startRef: React.Ref<HTMLSelectElement>;
  /** The saved pattern the editor was opened from. */
  readonly editing?: EditingView | undefined;
  /** What follows the steps: the run and the save controls, given by the panel. */
  readonly footer?: ((state: FooterState) => ReactNode) | undefined;
}

/** The builder of a pattern: where it starts and the steps that follow, every control a choice, a checkbox or a button; the server checks what is built. */
export function PatternEditor({ profile, retryProfile, client, sourceId, sourceName, mask, maxHops, state, dispatch, onCancel, startRef, editing, footer }: Props) {
  const { draft } = state;
  const title = editing === undefined ? BUILDER_COPY.title : editing.title;
  const ready = profile.kind === 'ready' ? profile.profile : undefined;
  const nameOf = (type: string | undefined): string => (type === undefined ? '' : (ready?.entityTypes.find((candidate) => candidate.type === type)?.displayName ?? type));
  const limit = stepLimitOf(maxHops);
  const definition = ready === undefined ? undefined : toDefinition(draft, ready, mask);
  const check = usePatternCheck(client, sourceId, mask, definition);
  const block = ready === undefined ? undefined : addStepBlock(ready, draft, limit);
  const reasonId = 'pattern-builder-add-reason';
  const problems = check.state.kind === 'invalid' ? check.state.problems : [];
  const at = (kind: 'top' | 'start'): PatternProblem[] => problems.filter((problem) => placeOf(problem).kind === kind);
  const lastCard = useRef<HTMLFieldSetElement>(null);
  const previousSteps = useRef(0);
  useEffect(() => {
    if (draft.steps.length > previousSteps.current) lastCard.current?.querySelector<HTMLElement>('select')?.focus();
    previousSteps.current = draft.steps.length;
  }, [draft.steps.length]);

  return (
    <section className="pattern-builder" aria-label={title}>
      <div className="pattern-builder-head">
        <button type="button" className="secondary" onClick={onCancel}>
          {BUILDER_COPY.back}
        </button>
      </div>
      {editing === undefined ? null : <EditingNotes editing={editing} />}
      <p className="search-panel-note">{BUILDER_COPY.intro}</p>
      <p className="search-panel-note">{BUILDER_COPY.mappingNote}</p>
      {profile.kind === 'loading' ? (
        <p className="search-panel-note" role="status">
          {BUILDER_COPY.loadingProfile}
        </p>
      ) : null}
      {profile.kind === 'failed' ? (
        <div className="patterns-state" role="alert">
          <p>{BUILDER_COPY.profileFailed}</p>
          <button type="button" className="secondary" onClick={retryProfile}>
            {BUILDER_COPY.retry}
          </button>
        </div>
      ) : null}
      <div className="patterns-field">
        <label className="supernode-label" htmlFor="pattern-builder-start">
          {BUILDER_COPY.startsAt}
        </label>
        <select id="pattern-builder-start" ref={startRef} className="patterns-input" disabled={ready === undefined} value={draft.anchorType ?? ''} onChange={(event) => dispatch({ type: 'start', anchorType: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{BUILDER_COPY.chooseType}</option>
          {(ready?.entityTypes ?? []).map((type) => (
            <option key={type.type} value={type.type}>
              {type.displayName}
            </option>
          ))}
        </select>
        <Problems list={at('start')} />
      </div>
      <PathLine draft={draft} nameOf={nameOf} />
      {ready === undefined ? null : (
        <>
          <p className="search-panel-note">{stepsLine(draft.steps.length, limit)}</p>
          {draft.steps.map((step, index) => (
            <StepCard
              key={index}
              ref={index === draft.steps.length - 1 ? lastCard : undefined}
              profile={ready}
              step={step}
              index={index}
              previous={previousTypeOf(draft, index)}
              last={index === draft.steps.length - 1}
              nameOf={nameOf}
              dispatch={dispatch}
              steps={draft.steps}
              mask={mask}
              problems={problems.filter((problem) => {
                const place = placeOf(problem);
                return (place.kind === 'step' && place.index === index) || (place.kind === 'condition' && place.index === index && place.row >= rowsOf(step).length);
              })}
              rowProblems={rowProblemsOf(problems, index)}
              unplaced={editing?.stepNotes.get(index) ?? []}
              windowProblems={problems.filter((problem) => {
                const place = placeOf(problem);
                return place.kind === 'window' && place.index === index;
              })}
            />
          ))}
          {state.windowDropped === true ? (
            <p className="search-panel-note" role="status">
              {CONDITIONS_COPY.windowDropped}
            </p>
          ) : null}
          {state.removed > 0 ? (
            <p className="search-panel-note" role="status">
              {BUILDER_COPY.removed}
            </p>
          ) : null}
          <div className="patterns-actions">
            <button type="button" className="secondary" disabled={block !== undefined} aria-describedby={block === undefined ? undefined : reasonId} onClick={() => dispatch({ type: 'add' })}>
              {BUILDER_COPY.addStep}
            </button>
          </div>
          {block === undefined ? null : (
            <p className="search-panel-note" id={reasonId}>
              {blockText(block, nameOf)}
            </p>
          )}
          <Problems list={at('top')} />
          <CheckResult state={check.state} sourceName={sourceName} retry={check.retry} />
          {footer === undefined ? null : footer({ profile: ready, definition, anchorType: draft.anchorType, check: check.state, validFor: check.validFor, nameOf, focusStart: () => document.getElementById('pattern-builder-start')?.focus() })}
        </>
      )}
    </section>
  );
}

/** What the editor says of a saved pattern it was opened from: that it is a change, and the reasons that have no step to sit beside (the ones that have one are in that step's card). */
function EditingNotes({ editing }: { readonly editing: EditingView }) {
  return (
    <>
      {editing.notes.map((text) => (
        <p key={text} className="search-panel-note">
          {text}
        </p>
      ))}
      {editing.loose.length === 0 ? null : (
        <ul className="pattern-row-reasons">
          {editing.loose.map((text, index) => (
            <li key={`${text}-${index}`} className="search-panel-note">
              {text}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function rowProblemsOf(problems: readonly PatternProblem[], index: number): ReadonlyMap<number, readonly PatternProblem[]> {
  const found = new Map<number, PatternProblem[]>();
  for (const problem of problems) {
    const place = placeOf(problem);
    if (place.kind !== 'condition' || place.index !== index) continue;
    found.set(place.row, [...(found.get(place.row) ?? []), problem]);
  }
  return found;
}

function Problems({ list }: { readonly list: readonly PatternProblem[] }) {
  return (
    <>
      {list.map((problem, index) => (
        <p className="patterns-error" key={`${problem.code}-${index}`}>
          {problemText(problem)}
        </p>
      ))}
    </>
  );
}

function PathLine({ draft, nameOf }: { readonly draft: BuilderStateDraft; readonly nameOf: (type: string | undefined) => string }) {
  if (draft.anchorType === undefined) return null;
  return (
    <div className="pattern-path" role="group" aria-label={BUILDER_COPY.path}>
      <span className="pattern-chip pattern-chip-node">{nameOf(draft.anchorType)}</span>
      {draft.steps.map((step, index) =>
        isComplete(step) && step.direction !== undefined && step.arrivesAt !== undefined ? (
          <span className="pattern-path-step" key={index} role="group" aria-label={`${DIRECTION_TEXT[step.direction]}: ${step.relationshipTypes.join(' or ')}`}>
            <span className="pattern-arrow" aria-hidden="true">
              {ARROW[step.direction]}
            </span>
            <span className="pattern-chip pattern-chip-rel">{step.relationshipTypes.join(' or ')}</span>
            <span className="pattern-arrow" aria-hidden="true">
              {ARROW[step.direction]}
            </span>
            <span className="pattern-chip pattern-chip-node">{nameOf(step.arrivesAt)}</span>
          </span>
        ) : null,
      )}
    </div>
  );
}

type BuilderStateDraft = BuilderState['draft'];

interface StepProps {
  readonly profile: SourceProfile;
  readonly step: StepDraft;
  readonly index: number;
  readonly previous: string | undefined;
  readonly last: boolean;
  readonly nameOf: (type: string | undefined) => string;
  readonly dispatch: (action: Action) => void;
  readonly steps: readonly StepDraft[];
  readonly mask: boolean;
  readonly problems: readonly PatternProblem[];
  readonly rowProblems: ReadonlyMap<number, readonly PatternProblem[]>;
  /** What the mapping no longer has in this step, said in words, when the builder was opened from a saved pattern. */
  readonly unplaced: readonly string[];
  readonly windowProblems: readonly PatternProblem[];
  readonly ref?: React.Ref<HTMLFieldSetElement> | undefined;
}

function StepCard({ profile, step, steps, index, previous, last, mask, nameOf, dispatch, problems, rowProblems, unplaced, windowProblems, ref }: StepProps) {
  const reached = previous === undefined || step.direction === undefined ? [] : arrivalTypes(profile, previous, step.direction);
  const choices = previous === undefined || step.direction === undefined || step.arrivesAt === undefined ? [] : relationshipChoices(profile, previous, step.arrivesAt, step.direction);
  const id = `pattern-step-${index}`;
  const atMost = step.relationshipTypes.length >= PATTERN_LIMITS.relationshipTypesPerStep;
  return (
    <fieldset className="patterns-field patterns-group pattern-step" ref={ref}>
      <legend className="supernode-label">{stepTitle(index)}</legend>
      {unplaced.map((text) => (
        <p key={text} className="search-panel-note" role="status">
          {text}
        </p>
      ))}
      <label className="supernode-label" htmlFor={`${id}-direction`}>
        {BUILDER_COPY.direction}
      </label>
      <select id={`${id}-direction`} className="patterns-input" value={step.direction ?? ''} onChange={(event) => dispatch({ type: 'direction', index, direction: DIRECTIONS.find((candidate) => candidate === event.target.value) })}>
        <option value="">{BUILDER_COPY.chooseDirection}</option>
        {DIRECTIONS.map((direction) => (
          <option key={direction} value={direction}>
            {DIRECTION_TEXT[direction]}
          </option>
        ))}
      </select>
      <label className="supernode-label" htmlFor={`${id}-arrives`}>
        {BUILDER_COPY.arrivesAt}
      </label>
      <select id={`${id}-arrives`} className="patterns-input" disabled={step.direction === undefined || reached.length === 0} value={step.arrivesAt ?? ''} onChange={(event) => dispatch({ type: 'arrives', index, arrivesAt: event.target.value === '' ? undefined : event.target.value })}>
        <option value="">{BUILDER_COPY.chooseArrival}</option>
        {reached.map((type) => (
          <option key={type} value={type}>
            {nameOf(type)}
          </option>
        ))}
      </select>
      {step.direction !== undefined && previous !== undefined && reached.length === 0 ? <p className="search-panel-note">{noArrival(nameOf(previous))}</p> : null}
      {step.arrivesAt === undefined ? null : (
        <div role="group" aria-label={BUILDER_COPY.relationshipTypes} className="pattern-types">
          <span className="supernode-label">{BUILDER_COPY.relationshipTypes}</span>
          {choices.map((type) => {
            const checked = step.relationshipTypes.includes(type);
            return (
              <label className="pattern-type" key={type}>
                <input type="checkbox" checked={checked} disabled={!checked && atMost} aria-describedby={!checked && atMost ? `${id}-types-reason` : undefined} onChange={() => dispatch({ type: 'toggle', index, relationshipType: type })} />
                {type}
              </label>
            );
          })}
          {atMost ? (
            <p className="search-panel-note" id={`${id}-types-reason`}>
              {tooManyTypes}
            </p>
          ) : null}
        </div>
      )}
      <ConditionsField profile={profile} step={step} steps={steps} index={index} previous={previous} mask={mask} nodeName={nameOf(step.arrivesAt)} dispatch={dispatch} rowProblems={rowProblems} />
      <WindowField profile={profile} step={step} index={index} previous={previous} dispatch={dispatch} problems={windowProblems} />
      <Problems list={problems} />
      {last ? (
        <button type="button" className="secondary" onClick={() => dispatch({ type: 'remove' })}>
          {BUILDER_COPY.removeStep}
        </button>
      ) : null}
    </fieldset>
  );
}

function CheckResult({ state, sourceName, retry }: { readonly state: CheckState; readonly sourceName: string; readonly retry: () => void }) {
  if (state.kind === 'none') return null;
  if (state.kind === 'failed') {
    const view = failureView(state.failure, sourceName);
    return (
      <div className="patterns-state" role="alert">
        <p>{BUILDER_COPY.checkFailed}</p>
        <p>{checkFailureText(state.failure.code, view.text)}</p>
        <button type="button" className="secondary" onClick={retry}>
          {BUILDER_COPY.retry}
        </button>
      </div>
    );
  }
  return (
    <p className="patterns-summary" role="status">
      {state.kind === 'checking' ? BUILDER_COPY.checking : state.kind === 'valid' ? BUILDER_COPY.valid : BUILDER_COPY.invalid}
    </p>
  );
}
