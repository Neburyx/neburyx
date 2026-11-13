import { type PatternProblem, type SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { CONDITIONS_COPY, WINDOW_COPY, cannotFilter, filteredOn } from './copy.js';
import { readWindow, windowOf, windowReach, windowTypeLines, type WindowDraft } from './conditions.js';
import type { Action, StepDraft } from './model.js';

interface Props {
  readonly profile: SourceProfile;
  readonly step: StepDraft;
  readonly index: number;
  readonly previous: string | undefined;
  readonly dispatch: (action: Action) => void;
  readonly problems: readonly PatternProblem[];
}

type Kind = WindowDraft['kind'];

const KINDS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: 'none', label: WINDOW_COPY.none },
  { kind: 'days', label: WINDOW_COPY.days },
  { kind: 'dates', label: WINDOW_COPY.dates },
];

/** The window of one step: none, the last days or two UTC dates, and which of the chosen relationship types the date can filter. */
export function WindowTab({ profile, step, index, previous, dispatch, problems }: Props) {
  const draft = windowOf(step);
  const reach = windowReach(profile, previous, step);
  const typed = step.relationshipTypes.length > 0 && step.arrivesAt !== undefined;
  const dated = reach.appliesTo.length > 0;
  const id = `pattern-step-${index}-window`;
  const read = readWindow(draft);
  const wrong = dated && !read.ok ? read : undefined;
  const choose = (kind: Kind): void => dispatch({ type: 'window', index, window: kind === 'none' ? { kind } : kind === 'days' ? { kind, text: '' } : { kind, from: '', to: '' } });
  const number = index + 1;
  return (
    <div className="patterns-window patterns-field" role="group" aria-label={WINDOW_COPY.legend}>
      <span className="supernode-label" id={`${id}-label`}>
        {WINDOW_COPY.legend}
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-note`} className="pattern-segments">
        {KINDS.map((entry) => (
          <button key={entry.kind} type="button" role="radio" aria-checked={(dated ? draft.kind : 'none') === entry.kind} disabled={!dated} className="pattern-segment" onClick={() => choose(entry.kind)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div id={`${id}-note`}>
        {!typed ? <p className="pattern-help">{CONDITIONS_COPY.windowChooseTypes}</p> : null}
        {typed && !dated ? <p className="pattern-help">{CONDITIONS_COPY.windowNoDated}</p> : null}
      </div>
      {draft.kind === 'days' && dated ? (
        <label className="condition-field">
          <span className="supernode-label">{WINDOW_COPY.daysField}</span>
          <input className="patterns-input" aria-label={`Step ${number} window: ${WINDOW_COPY.daysField}`} aria-invalid={wrong?.at === 'days' ? true : undefined} inputMode="numeric" value={draft.text} onChange={(event) => dispatch({ type: 'window', index, window: { kind: 'days', text: event.target.value } })} />
          <span className="pattern-help">{WINDOW_COPY.daysHelp}</span>
          {wrong?.at === 'days' ? (
            <span className="patterns-error" role="alert">
              {wrong.reason}
            </span>
          ) : null}
        </label>
      ) : null}
      {draft.kind === 'dates' && dated ? (
        <div className="condition-field">
          <div className="condition-form-pair">
            <label className="condition-field">
              <span className="supernode-label">{WINDOW_COPY.from}</span>
              <input className="patterns-input" aria-label={`Step ${number} window: ${WINDOW_COPY.from}`} aria-invalid={wrong?.at === 'from' ? true : undefined} placeholder="2026-03-01" value={draft.from} onChange={(event) => dispatch({ type: 'window', index, window: { ...draft, from: event.target.value } })} />
              {wrong?.at === 'from' ? (
                <span className="patterns-error" role="alert">
                  {wrong.reason}
                </span>
              ) : null}
            </label>
            <label className="condition-field">
              <span className="supernode-label">{WINDOW_COPY.to}</span>
              <input className="patterns-input" aria-label={`Step ${number} window: ${WINDOW_COPY.to}`} aria-invalid={wrong?.at === 'to' ? true : undefined} placeholder="2026-03-31" value={draft.to} onChange={(event) => dispatch({ type: 'window', index, window: { ...draft, to: event.target.value } })} />
              {wrong?.at === 'to' ? (
                <span className="patterns-error" role="alert">
                  {wrong.reason}
                </span>
              ) : null}
            </label>
          </div>
          <span className="pattern-help">{WINDOW_COPY.datesHelp}</span>
          {wrong?.at === 'range' ? (
            <span className="patterns-error" role="alert">
              {wrong.reason}
            </span>
          ) : null}
        </div>
      ) : null}
      {typed ? (
        <div className="patterns-state" data-tone="warning" role="group" aria-label={WINDOW_COPY.canFilter}>
          <p>{WINDOW_COPY.canFilter}</p>
          {windowTypeLines(profile, previous, step).map((line) => (
            <p key={line.type} className="window-type-line">
              <span className="popup-menu-type">{line.type}</span> {line.datedOn.length > 0 ? filteredOn(line.datedOn) : WINDOW_COPY.noDate}
              {line.datedOn.length > 0 && line.undated ? <span>{`; a row of it has no date in the mapping`}</span> : null}
            </p>
          ))}
          {windowTypeLines(profile, previous, step)
            .filter((line) => line.undated)
            .map((line) => (
              <p key={line.type}>{cannotFilter(line.type)}</p>
            ))}
        </div>
      ) : null}
      {problems.map((found, place) => (
        <p className="patterns-error" key={`${found.code}-${place}`}>
          {problemText(found)}
        </p>
      ))}
    </div>
  );
}
