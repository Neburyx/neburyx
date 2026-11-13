import type { PatternProblem, SourceProfile } from '@neburyx/contracts';
import { problemText } from '../copy.js';
import { AddTypeMenu } from './add-type-menu.js';
import { LINK_COPY, directionMeaning, noArrival, relationshipTypesTitle, removeTypeLabel } from './copy.js';
import { DIRECTIONS, arrivalTypes, relationshipChoices, typeOptions, type Action, type StepDraft } from './model.js';
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
}

/** The Link tab of a step: its direction, the relationship types and the type it arrives at. */
export function LinkTab({ profile, step, index, previous, nameOf, dispatch, problems }: Props) {
  const id = `pattern-step-${index}`;
  const reached = previous === undefined || step.direction === undefined ? [] : arrivalTypes(profile, previous, step.direction);
  const choices = previous === undefined || step.direction === undefined || step.arrivesAt === undefined ? [] : relationshipChoices(profile, previous, step.arrivesAt, step.direction);
  const options = previous === undefined || step.direction === undefined ? [] : typeOptions(profile, previous, step.direction, step.arrivesAt);
  const full = step.relationshipTypes.length >= PATTERN_LIMITS.relationshipTypesPerStep;
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
      <div className="patterns-field" role="group" aria-label="Relationship types">
        <span className="supernode-label">{relationshipTypesTitle(step.relationshipTypes.length)}</span>
        <div className="pattern-chips">
          {step.relationshipTypes.map((type) => (
            <span key={type} className="pattern-chip pattern-chip-rel pattern-chip-removable">
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
        {step.direction === undefined ? <p className="pattern-help">Choose a direction first.</p> : null}
        {step.arrivesAt !== undefined && choices.length === 0 && step.direction !== undefined ? <p className="pattern-help">{`No relationship type in the mapping joins ${nameOf(previous)} to ${nameOf(step.arrivesAt)} in this direction.`}</p> : null}
        {full ? <p className="pattern-help">{LINK_COPY.typesAtMost}</p> : null}
      </div>
      <div className="patterns-field">
        <label className="supernode-label" htmlFor={`${id}-arrives`}>
          {LINK_COPY.arrivesAt}
        </label>
        <select id={`${id}-arrives`} className="patterns-input" disabled={step.direction === undefined || reached.length === 0} value={step.arrivesAt ?? ''} onChange={(event) => dispatch({ type: 'arrives', index, arrivesAt: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{LINK_COPY.chooseType}</option>
          {reached.map((type) => (
            <option key={type} value={type}>
              {nameOf(type)}
            </option>
          ))}
        </select>
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
