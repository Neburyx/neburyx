import { type PatternProblem, type SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { CONDITIONS_COPY, windowAppliesText, windowNotAppliedText } from './copy.js';
import { readWindow, windowOf, windowReach, type WindowDraft } from './conditions.js';
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
  { kind: 'none', label: CONDITIONS_COPY.windowNone },
  { kind: 'days', label: CONDITIONS_COPY.windowDays },
  { kind: 'dates', label: CONDITIONS_COPY.windowDates },
];

/** The window of one step: none until chosen, the last days or two UTC dates, with the relationship types it filters and those it does not. */
export function WindowField({ profile, step, index, previous, dispatch, problems }: Props) {
  const draft = windowOf(step);
  const reach = windowReach(profile, previous, step);
  const typed = step.relationshipTypes.length > 0 && step.arrivesAt !== undefined;
  const dated = reach.appliesTo.length > 0;
  const id = `pattern-step-${index}-window`;
  const read = readWindow(draft);
  const choose = (kind: Kind): void => dispatch({ type: 'window', index, window: kind === 'none' ? { kind } : kind === 'days' ? { kind, text: '' } : { kind, from: '', to: '' } });
  return (
    <fieldset className="patterns-field patterns-window">
      <legend className="supernode-label">{CONDITIONS_COPY.windowLegend}</legend>
      <select aria-label={CONDITIONS_COPY.windowKind} className="patterns-input" disabled={!dated} aria-describedby={`${id}-note`} value={dated ? draft.kind : 'none'} onChange={(event) => choose(KINDS.find((entry) => entry.kind === event.target.value)?.kind ?? 'none')}>
        {KINDS.map((entry) => (
          <option key={entry.kind} value={entry.kind}>
            {entry.label}
          </option>
        ))}
      </select>
      {draft.kind === 'days' && dated ? (
        <input className="patterns-input" aria-label={`Step ${index + 1} window: ${CONDITIONS_COPY.windowDaysField}`} aria-invalid={read.ok ? undefined : true} inputMode="numeric" value={draft.text} onChange={(event) => dispatch({ type: 'window', index, window: { kind: 'days', text: event.target.value } })} />
      ) : null}
      {draft.kind === 'dates' && dated ? (
        <>
          <input className="patterns-input" aria-label={`Step ${index + 1} window: ${CONDITIONS_COPY.windowFrom}`} aria-invalid={read.ok ? undefined : true} value={draft.from} onChange={(event) => dispatch({ type: 'window', index, window: { ...draft, from: event.target.value } })} />
          <input className="patterns-input" aria-label={`Step ${index + 1} window: ${CONDITIONS_COPY.windowTo}`} aria-invalid={read.ok ? undefined : true} value={draft.to} onChange={(event) => dispatch({ type: 'window', index, window: { ...draft, to: event.target.value } })} />
        </>
      ) : null}
      <div id={`${id}-note`}>
        {!typed ? <p className="neighbor-types-note">{CONDITIONS_COPY.windowChooseTypes}</p> : null}
        {typed && !dated ? <p className="neighbor-types-note">{CONDITIONS_COPY.windowNoDated}</p> : null}
        {dated && draft.kind !== 'none' ? <p className="neighbor-types-note">{windowAppliesText(reach.appliesTo)}</p> : null}
        {dated && draft.kind !== 'none' && reach.notAppliedTo.length > 0 ? <p className="neighbor-types-note">{windowNotAppliedText(reach.notAppliedTo)}</p> : null}
        {dated && !read.ok ? (
          <p className="neighbor-types-note" role="alert">
            {read.reason}
          </p>
        ) : null}
        {problems.map((found, place) => (
          <p className="patterns-error" key={`${found.code}-${place}`}>
            {problemText(found)}
          </p>
        ))}
      </div>
    </fieldset>
  );
}
