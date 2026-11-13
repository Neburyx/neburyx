import type { PatternProblem, SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { AddTypeMenu } from './add-type-menu.js';
import { LINK_COPY, arrivalChanged, directionMeaning, doesNotLeave, leadsElsewhere, noArrival, relationshipTypesTitle, removeTypeLabel } from './copy.js';
import { DIRECTIONS, arrivalTypes, leadsTo, relationshipChoices, typeOptions, type Action, type Break, type StepDraft } from './model.js';
import { PATTERN_LIMITS } from '@neburyx/contracts';

interface Props {
  readonly profile: SourceProfile;
  readonly step: StepDraft;
  readonly index: number;
  /** The node type the step leaves, which the first step takes from the start. */
  readonly previous: string | undefined;
  readonly nameOf: (type: string | undefined) => string;
  readonly dispatch: (action: Action) => void;
  readonly problems: readonly PatternProblem[];
  /** The parts of this step's link that the mapping does not follow. */
  readonly breaks: readonly Break[];
  /** The arrival type this step had before the change that broke it, when there is one to name. */
  readonly was: string | undefined;
}

/** The Link tab of a step: its direction, the relationship types and the type it arrives at. */
export function LinkTab({ profile, step, index, previous, nameOf, dispatch, problems, breaks, was }: Props) {
  const id = `pattern-step-${index}`;
  const reached = previous === undefined || step.direction === undefined ? [] : arrivalTypes(profile, previous, step.direction);
  const choices = previous === undefined || step.direction === undefined || step.arrivesAt === undefined ? [] : relationshipChoices(profile, previous, step.arrivesAt, step.direction);
  const options = previous === undefined || step.direction === undefined ? [] : typeOptions(profile, previous, step.direction, step.arrivesAt);
  const full = step.relationshipTypes.length >= PATTERN_LIMITS.relationshipTypesPerStep;
  const wrongTypes = new Map<string, string>();
  for (const found of breaks) {
    if (found.kind === 'types-leave') for (const type of found.types) wrongTypes.set(type, doesNotLeave(type, nameOf(found.from)));
    if (found.kind === 'types-lead' && previous !== undefined && step.direction !== undefined) for (const type of found.types) wrongTypes.set(type, leadsElsewhere(type, leadsTo(profile, type, previous, step.direction).map((name) => nameOf(name)), nameOf(found.arrival)));
  }
  const arrivalWrong = breaks.some((found) => found.kind === 'arrival' || found.kind === 'types-lead');
  return (
    <>
      <div className="patterns-field">
        <span className="supernode-label" id={`${id}-direction-label`}>
          {LINK_COPY.direction}
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-direction-label`} aria-describedby={`${id}-direction-meaning`} className="pattern-segments">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction}
              type="button"
              role="radio"
              id={`${id}-direction-${direction}`}
              aria-checked={step.direction === direction}
              className="pattern-segment"
              onClick={() => dispatch({ type: 'direction', index, direction })}
            >
              {LINK_COPY[direction]}
            </button>
          ))}
        </div>
        {step.direction === undefined || previous === undefined ? null : (
          <p className="pattern-help" id={`${id}-direction-meaning`}>
            {directionMeaning(step.direction, nameOf(previous))}
          </p>
        )}
      </div>
      <div className="patterns-field" role="group" aria-label="Relationship types" aria-describedby={wrongTypes.size === 0 ? undefined : [...wrongTypes.values()].map((_, place) => `${id}-types-problem-${place}`).join(' ')}>
        <span className="supernode-label">{relationshipTypesTitle(step.relationshipTypes.length)}</span>
        <div className="pattern-chips">
          {step.relationshipTypes.map((type) => (
            <span key={type} className="pattern-chip pattern-chip-rel pattern-chip-removable" data-broken={wrongTypes.has(type) ? 'true' : undefined}>
              {type}
              <button type="button" className="pattern-chip-remove" aria-label={removeTypeLabel(type)} onClick={() => dispatch({ type: 'toggle', index, relationshipType: type })}>
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
          {previous === undefined || step.direction === undefined || options.length === 0 ? null : (
            <AddTypeMenu
              from={previous}
              direction={step.direction}
              options={options}
              chosen={step.relationshipTypes}
              full={full}
              nameOf={nameOf}
              onToggle={(option) => {
                if (step.arrivesAt !== option.arrival) dispatch({ type: 'arrives', index, arrivesAt: option.arrival });
                dispatch({ type: 'toggle', index, relationshipType: option.type });
              }}
            />
          )}
        </div>
        {[...wrongTypes.values()].map((text, place) => (
          <p key={text} className="patterns-error" id={`${id}-types-problem-${place}`}>
            {text}
          </p>
        ))}
        {step.direction === undefined ? <p className="pattern-help">Choose a direction first.</p> : null}
        {step.arrivesAt !== undefined && choices.length === 0 && step.direction !== undefined ? <p className="pattern-help">{`No relationship type in the mapping joins ${nameOf(previous)} to ${nameOf(step.arrivesAt)} in this direction.`}</p> : null}
        {full ? <p className="pattern-help">{LINK_COPY.typesAtMost}</p> : null}
      </div>
      <div className="patterns-field">
        <label className="supernode-label" htmlFor={`${id}-arrives`}>
          {LINK_COPY.arrivesAt}
        </label>
        <select id={`${id}-arrives`} className="patterns-input" data-broken={arrivalWrong ? 'true' : undefined} aria-invalid={arrivalWrong ? true : undefined} aria-describedby={arrivalWrong ? `${id}-arrival-problem` : undefined} disabled={step.direction === undefined || (reached.length === 0 && step.arrivesAt === undefined)} value={step.arrivesAt ?? ''} onChange={(event) => dispatch({ type: 'arrives', index, arrivesAt: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{LINK_COPY.chooseType}</option>
          {(step.arrivesAt === undefined || reached.includes(step.arrivesAt) ? reached : [...reached, step.arrivesAt]).map((type) => (
            <option key={type} value={type}>
              {nameOf(type)}
            </option>
          ))}
        </select>
        {arrivalWrong && step.arrivesAt !== undefined ? <p className="patterns-error" id={`${id}-arrival-problem`}>{arrivalChanged(was === undefined || was === step.arrivesAt ? undefined : nameOf(was), nameOf(step.arrivesAt))}</p> : null}
        {step.direction !== undefined && previous !== undefined && reached.length === 0 ? <p className="pattern-help">{noArrival(nameOf(previous))}</p> : null}
      </div>
      {problems.map((found, place) => (
        <p className="patterns-error" key={`${found.code}-${place}`}>
          {problemText(found)}
        </p>
      ))}
    </>
  );
}
