import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PatternDefinition, PatternProblem, SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { Dialog } from '../../views/dialog.js';
import { failureView, problemText } from '../copy.js';
import { BreakBanner } from './break-banner.js';
import { ChainSummary } from './chain-summary.js';
import { BUILDER_COPY, CHECK_COPY, EDITOR_COPY, blockText, checkedAtText, placeOf, previewWhy, type ProblemPlace } from './copy.js';
import { ProblemsPanel } from './problems-panel.js';
import { TRY_AGAIN, rateLimitedSentence, retryAfterMsOf, tryAgainIn } from '../failure-words.js';
import { addStepBlock, breaksOf, hasConditions, previousTypeOf, stepLimitOf, toDefinition, type Action, type BuilderState } from './model.js';
import { rowsOf, totalConditions } from './conditions.js';
import { StepPanel, type Part } from './step-panel.js';
import { TabList, panelId, tabId } from './tabs.js';
import { usePatternCheck, type CheckState } from './use-check.js';

export type { CheckState };
export { CHECK_DEBOUNCE_MS } from './use-check.js';

export type ProfileView = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly failure?: ApiFailure } | { readonly kind: 'ready'; readonly profile: SourceProfile };

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

/** The editor of a pattern: the chain on top, a tab for the start and for each step, the part of a step that is open, and Cancel and Preview below; the source checks what is built. */
export function PatternEditor({ profile, retryProfile, client, sourceId, sourceName, mask, maxHops, state, dispatch, onCancel, onPreview, startRef, editing, footer }: Props) {
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
  const breaks = ready === undefined ? [] : breaksOf(ready, draft, mask);
  const [selected, setSelected] = useState<'start' | number>('start');
  const [part, setPart] = useState<Part>('link');
  const [asking, setAsking] = useState<'discard' | { readonly remove: number } | undefined>(undefined);
  const focusNew = useRef(false);
  const focusStart = useRef(false);
  const showing = useRef<ProblemPlace | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  // a step that is gone cannot stay selected
  const current = selected !== 'start' && selected >= draft.steps.length ? (draft.steps.length === 0 ? 'start' : draft.steps.length - 1) : selected;
  useEffect(() => {
    if (current !== selected) setSelected(current);
  }, [current, selected]);
  useEffect(() => {
    if (!focusStart.current || current !== 'start') return;
    focusStart.current = false;
    document.getElementById('pattern-builder-start')?.focus();
  }, [current, selected]);
  useEffect(() => {
    if (!focusNew.current) return;
    focusNew.current = false;
    panel.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
  }, [draft.steps.length]);
  const key = definition === undefined ? undefined : JSON.stringify(definition);
  const checked = check.state.kind === 'valid' && check.validFor === key && breaks.length === 0;
  const empty = draft.anchorType === undefined && draft.steps.length === 0;
  /** Leaves the editor: at once while nothing is built, and after asking while a draft would be thrown away. */
  const cancel = (): void => (empty ? onCancel() : setAsking('discard'));
  const addStep = (): void => {
    dispatch({ type: 'add' });
    setSelected(draft.steps.length);
    setPart('link');
    focusNew.current = true;
  };
  const selectStep = (id: string): void => {
    setSelected(id === 'start' ? 'start' : Number(id.slice('step-'.length)));
    setPart('link');
  };
  /** Opens the tab and the part a problem is in, and puts the focus on its control. */
  const show = (place: ProblemPlace): void => {
    if (place.kind === 'start') setSelected('start');
    else if (place.kind === 'top') return;
    else {
      setSelected(place.index);
      setPart(place.kind === 'condition' ? 'conditions' : place.kind === 'window' ? 'window' : 'link');
    }
    showing.current = place;
  };
  useEffect(() => {
    const place = showing.current;
    if (place === undefined) return;
    showing.current = undefined;
    const target =
      place.kind === 'start'
        ? document.getElementById('pattern-builder-start')
        : place.kind === 'condition'
          ? panel.current?.querySelector<HTMLElement>(`[role="group"][aria-label="Step ${place.index + 1} condition ${place.row + 1}"] button, [role="group"][aria-label="Step ${place.index + 1} condition ${place.row + 1}"] select`)
          : place.kind === 'window'
            ? panel.current?.querySelector<HTMLElement>('.patterns-window [role="radio"]')
            : panel.current?.querySelector<HTMLElement>('[role="radio"], select');
    target?.focus();
  }, [selected, part]);
  const serverAt = (index: number): number => problems.filter((problem) => {
    const place = placeOf(problem);
    return (place.kind === 'step' || place.kind === 'condition' || place.kind === 'window') && place.index === index;
  }).length;
  const wrongAt = (index: number): boolean => breaks.some((found) => found.step === index) || serverAt(index) > 0;
  const tabs = [
    { id: 'start', label: EDITOR_COPY.start },
    ...draft.steps.map((candidate, index) => {
      const bad = wrongAt(index);
      const description = `Step ${index + 1} of ${draft.steps.length}, ${candidate.relationshipTypes.join(' or ')} to ${nameOf(candidate.arrivesAt)}, ${bad ? 'has a problem' : checked ? 'valid' : 'not checked yet'}`;
      return { id: `step-${index}`, label: bad ? `Step ${index + 1} !` : `Step ${index + 1}`, ...(bad ? { marked: true } : {}), description };
    }),
  ];
  const selectedId = current === 'start' ? 'start' : `step-${current}`;
  const step = current === 'start' ? undefined : draft.steps[current];

  return (
    <section className="pattern-builder" aria-label={title}>
      <div className="pattern-editor-body">
        {editing === undefined ? null : <EditingNotes editing={editing} />}
        {profile.kind === 'loading' ? (
          <div className="pattern-loading" role="status">
            <div className="pattern-skeleton" aria-hidden="true" />
            <p>{CHECK_COPY.loadingMapping}</p>
            <p className="pattern-help">{CHECK_COPY.editingOff}</p>
          </div>
        ) : null}
        {profile.kind === 'failed' ? (
          <div className="patterns-state" data-tone="bad" role="alert">
            <p>{CHECK_COPY.couldNotRead}</p>
            <p>{profile.failure === undefined ? BUILDER_COPY.profileFailed : failureView(profile.failure, sourceName).text}</p>
            <p>{CHECK_COPY.nothingChanged}</p>
            <div className="patterns-actions">
              <button type="button" className="primary" onClick={retryProfile}>
                {TRY_AGAIN}
              </button>
              <button type="button" className="secondary" onClick={cancel}>
                {CHECK_COPY.close}
              </button>
            </div>
          </div>
        ) : null}
        <ChainSummary draft={draft} nameOf={nameOf} valid={checked} problems={breaks.length} brokenSteps={new Set(draft.steps.flatMap((_, index) => (wrongAt(index) ? [index] : [])))} sourceProblems={breaks.length === 0 ? problems.length : 0} stepLimit={limit} />
        <BreakBanner breaks={breaks} undo={state.undo} nameOf={nameOf} onUndo={() => dispatch({ type: 'undo' })} />
        {breaks.length === 0 ? <ProblemsPanel problems={problems} onShow={show} /> : null}
        <>
            <TabList
              label={EDITOR_COPY.stepsLabel}
              idPrefix="pattern-steps"
              tabs={tabs}
              selected={selectedId}
              onSelect={selectStep}
              activation="manual"
              trailing={
                <button type="button" className="pattern-add-step" disabled={ready === undefined || block !== undefined} aria-describedby={block === undefined ? undefined : reasonId} onClick={addStep}>
                  {EDITOR_COPY.addStep}
                </button>
              }
            />
            {block === undefined ? null : (
              <p className="search-panel-note" id={reasonId}>
                {blockText(block, nameOf)}
              </p>
            )}
            <div ref={panel}>
              {current === 'start' || step === undefined || ready === undefined ? (
                <div role="tabpanel" id={panelId('pattern-steps', 'start')} aria-labelledby={tabId('pattern-steps', 'start')} className="pattern-step-panel">
                  <p className="pattern-step-title">{EDITOR_COPY.start}</p>
                  <p className="pattern-step-summary">{EDITOR_COPY.startExplain}</p>
                  <div className="patterns-field">
                    <label className="supernode-label" htmlFor="pattern-builder-start">
                      {EDITOR_COPY.startType}
                    </label>
                    <select id="pattern-builder-start" ref={startRef} className="patterns-input" disabled={ready === undefined} value={draft.anchorType ?? ''} onChange={(event) => dispatch({ type: 'start', anchorType: event.target.value === '' ? undefined : event.target.value })}>
                      <option value="">{BUILDER_COPY.chooseType}</option>
                      <optgroup label={EDITOR_COPY.typesInMapping}>
                        {(ready?.entityTypes ?? []).map((type) => (
                          <option key={type.type} value={type.type}>
                            {type.displayName}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <Problems list={at('start')} />
                  </div>
                </div>
              ) : (
                <StepPanel
                  profile={ready}
                  step={step}
                  steps={draft.steps}
                  index={current}
                  previous={previousTypeOf(draft, current)}
                  mask={mask}
                  nameOf={nameOf}
                  dispatch={dispatch}
                  part={part}
                  onPart={setPart}
                  breaks={breaks.filter((found) => found.step === current)}
                  serverProblems={problems.filter((problem) => {
                    const place = placeOf(problem);
                    return (place.kind === 'step' || place.kind === 'condition' || place.kind === 'window') && place.index === current;
                  })}
                  was={state.undo?.draft.steps[current]?.arrivesAt}
                  onRemove={() => (hasConditions(step) ? setAsking({ remove: current }) : dispatch({ type: 'remove', index: current }))}
                  problems={problems.filter((problem) => {
                    const place = placeOf(problem);
                    return (place.kind === 'step' && place.index === current) || (place.kind === 'condition' && place.index === current && place.row >= rowsOf(step).length);
                  })}
                  rowProblems={rowProblemsOf(problems, current)}
                  windowProblems={problems.filter((problem) => {
                    const place = placeOf(problem);
                    return place.kind === 'window' && place.index === current;
                  })}
                  unplaced={editing?.stepNotes.get(current) ?? []}
                />
              )}
            </div>
            <CheckResult state={check.state} sourceName={sourceName} retry={check.retry} checkedAt={check.checkedAt} />
            {footer === undefined || ready === undefined ? null : footer({ profile: ready, definition, anchorType: draft.anchorType, check: check.state, validFor: check.validFor, nameOf, focusStart: () => { setSelected('start'); focusStart.current = true; } })}
        </>
      </div>
      <div className="pattern-editor-actions">
        <button type="button" className="secondary" onClick={cancel}>
          {EDITOR_COPY.cancel}
        </button>
        <button type="button" className="primary" disabled={!checked || definition === undefined} aria-describedby={checked && definition !== undefined ? undefined : 'pattern-preview-why'} onClick={() => definition !== undefined && onPreview(definition)}>
          {EDITOR_COPY.preview}
        </button>
        {checked && definition !== undefined ? null : (
          <span hidden id="pattern-preview-why">
            {previewWhy(breaks.length, problems.length, definition !== undefined, check.state.kind)}
          </span>
        )}
      </div>
      {asking === undefined ? null : (
        <Dialog title={asking === 'discard' ? EDITOR_COPY.discardTitle : EDITOR_COPY.removeTitle(asking.remove + 1)} onClose={() => setAsking(undefined)}>
          {() => (
            <div className="rename-form">
              <p>{asking === 'discard' ? EDITOR_COPY.discardText : EDITOR_COPY.removeText(rowsOf(draft.steps[asking.remove] ?? { relationshipTypes: [] }).length)}</p>
              <div className="rename-actions">
                <button type="button" className="secondary" onClick={() => setAsking(undefined)}>
                  {asking === 'discard' ? EDITOR_COPY.keepEditing : EDITOR_COPY.cancel}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const was = asking;
                    setAsking(undefined);
                    if (was === 'discard') onCancel();
                    else dispatch({ type: 'remove', index: was.remove });
                  }}
                >
                  {asking === 'discard' ? EDITOR_COPY.discard : EDITOR_COPY.remove}
                </button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}

/** What the editor says of a saved pattern it was opened from: that it is a change, and the reasons that have no step to sit beside (the ones that have one are in that step's panel). */
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

/** Counts the seconds of a wait down to nothing, one a second. */
function useCountdown(waitMs: number | undefined): number {
  const [left, setLeft] = useState(waitMs === undefined ? 0 : Math.ceil(waitMs / 1000));
  useEffect(() => setLeft(waitMs === undefined ? 0 : Math.ceil(waitMs / 1000)), [waitMs]);
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return left;
}

/** What the check says besides the problems: that it is on its way, that it could not be made (in words, with Try again, and the wait of a rate limit counted down), and when the source last answered. */
function CheckResult({ state, sourceName, retry, checkedAt }: { readonly state: CheckState; readonly sourceName: string; readonly retry: () => void; readonly checkedAt: Date | undefined }) {
  const wait = state.kind === 'failed' && state.failure.code === 'RATE_LIMITED' ? retryAfterMsOf(state.failure) : undefined;
  const left = useCountdown(wait);
  if (state.kind === 'none') return null;
  if (state.kind === 'checking') {
    return (
      <div className="patterns-summary" role="status">
        <p>{CHECK_COPY.checking}</p>
        <p className="pattern-help">{CHECK_COPY.checkingNote}</p>
      </div>
    );
  }
  if (state.kind === 'failed') {
    if (state.failure.code === 'RATE_LIMITED') {
      return (
        <div className="patterns-state" data-tone="warning" role="alert">
          <p>{`${CHECK_COPY.tooMany} ${wait === undefined ? 'Try again in a moment.' : rateLimitedSentence(left)}`}</p>
          <button type="button" className="secondary" disabled={wait !== undefined && left > 0} onClick={retry}>
            {wait === undefined ? TRY_AGAIN : tryAgainIn(left)}
          </button>
        </div>
      );
    }
    const view = failureView(state.failure, sourceName);
    return (
      <div className="patterns-state" role="alert">
        <p>{CHECK_COPY.couldNot}</p>
        <p>{view.text}</p>
        <button type="button" className="secondary" onClick={retry}>
          {TRY_AGAIN}
        </button>
      </div>
    );
  }
  return checkedAt === undefined ? null : <p className="pattern-help">{checkedAtText(checkedAt)}</p>;
}
