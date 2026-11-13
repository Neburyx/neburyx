import { PATTERN_LIMITS, type PatternProblem, type SourceProfile } from '@neburyx/contracts';
import { FILTER_FROM_LABEL, FILTER_KIND_LABEL, FILTER_OPERATORS, FILTER_OPERATOR_LABEL, FILTER_PROPERTY_LABEL, FILTER_ROW_UNAVAILABLE, FILTER_TO_LABEL, FILTER_VALUES_LABEL, FILTER_VALUE_LABEL, PERSONAL_DATA_NOT_OFFERED, filterPropertyOption } from '../../workspace/expand-copy.js';
import { FILTER_KIND_CHOICES, KIND_LABELS, readDraft } from '../../workspace/expand-refine.js';
import { CONDITIONS_COPY, conditionBlockText, problemText, sideCapText } from './copy.js';
import { addConditionBlock, countOn, isOffered, maskLeftOut, offeredProperties, rowsOf, type ConditionRow } from './conditions.js';
import type { Action, StepDraft } from './model.js';

const encode = (on: ConditionRow['on'], property: string): string => `${on}:${property}`;
const decode = (value: string): { readonly on: ConditionRow['on']; readonly property: string } | undefined => {
  const at = value.indexOf(':');
  const on = value.slice(0, at);
  return at > 0 && (on === 'neighbor' || on === 'relationship') ? { on, property: value.slice(at + 1) } : undefined;
};

interface Props {
  readonly profile: SourceProfile;
  readonly step: StepDraft;
  readonly steps: readonly StepDraft[];
  readonly index: number;
  readonly previous: string | undefined;
  readonly mask: boolean;
  readonly nodeName: string;
  readonly dispatch: (action: Action) => void;
  /** The server's problems at this step's rows, by the row's place in the list. */
  readonly rowProblems: ReadonlyMap<number, readonly PatternProblem[]>;
}

/** The conditions of one step: a row for each, on the step's node or its relationship, read as Expand's filter rows are, and the control that adds one. */
export function ConditionsField({ profile, step, steps, index, previous, mask, nodeName, dispatch, rowProblems }: Props) {
  const offered = offeredProperties(profile, previous, step, mask);
  const rows = rowsOf(step);
  const block = addConditionBlock(offered, step, steps);
  const reasonId = `pattern-step-${index}-conditions-reason`;
  const number = index + 1;
  const full = (['neighbor', 'relationship'] as const).filter((on) => countOn(rows, on) >= PATTERN_LIMITS.conditionsPerElement && offered[on].length > 0 && !(block?.kind === 'side-cap' && block.on === on));
  return (
    <fieldset className="patterns-field patterns-conditions">
      <legend className="supernode-label">{CONDITIONS_COPY.legend}</legend>
      {rows.map((row, at) => {
        const label = `Step ${number} condition ${at + 1}`;
        const read = row.touched === true ? readDraft(row) : undefined;
        const problem = read !== undefined && !read.ok ? read.reason : undefined;
        const available = isOffered(row, offered);
        const change = (patch: Partial<ConditionRow>): void => dispatch({ type: 'change-condition', index, id: row.id, change: patch });
        const option = (on: ConditionRow['on'], property: string): React.ReactNode => (
          <option key={encode(on, property)} value={encode(on, property)} disabled={!(on === row.on && property === row.property) && countOn(rows, on) >= PATTERN_LIMITS.conditionsPerElement}>
            {filterPropertyOption(on, property, nodeName)}
          </option>
        );
        return (
          <div key={row.id} className="supernode-filter-row" role="group" aria-label={label}>
            <select
              aria-label={`${label}: ${FILTER_PROPERTY_LABEL}`}
              value={encode(row.on, row.property)}
              onChange={(event) => {
                const chosen = decode(event.target.value);
                if (chosen !== undefined) change(chosen);
              }}
            >
              {available ? null : <option value={encode(row.on, row.property)}>{filterPropertyOption(row.on, row.property, nodeName)}</option>}
              {offered.neighbor.map((property) => option('neighbor', property))}
              {offered.relationship.map((property) => option('relationship', property))}
            </select>
            <select aria-label={`${label}: ${FILTER_OPERATOR_LABEL}`} value={row.op} onChange={(event) => change({ op: event.target.value === 'in' ? 'in' : event.target.value === 'between' ? 'between' : 'eq' })}>
              {(['eq', 'in', 'between'] as const).map((op) => (
                <option key={op} value={op}>
                  {FILTER_OPERATORS[op]}
                </option>
              ))}
            </select>
            {row.op === 'between' ? (
              <>
                <input className="supernode-number" aria-label={`${label}: ${FILTER_FROM_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={row.from} onChange={(event) => change({ from: event.target.value })} />
                <input className="supernode-number" aria-label={`${label}: ${FILTER_TO_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={row.to} onChange={(event) => change({ to: event.target.value })} />
              </>
            ) : (
              <input className="supernode-number" aria-label={`${label}: ${row.op === 'in' ? FILTER_VALUES_LABEL : FILTER_VALUE_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={row.text} onChange={(event) => change({ text: event.target.value })} />
            )}
            <select aria-label={`${label}: ${FILTER_KIND_LABEL}`} value={row.kind} onChange={(event) => change({ kind: FILTER_KIND_CHOICES.find((kind) => kind === event.target.value) ?? 'auto' })}>
              {FILTER_KIND_CHOICES.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <button type="button" className="neighbor-types-link" aria-label={`${CONDITIONS_COPY.remove} ${at + 1} of step ${number}`} onClick={() => dispatch({ type: 'remove-condition', index, id: row.id })}>
              {CONDITIONS_COPY.remove}
            </button>
            {available ? null : (
              <p className="neighbor-types-note" role="alert">
                {FILTER_ROW_UNAVAILABLE}
              </p>
            )}
            {problem === undefined ? null : (
              <p className="neighbor-types-note" role="alert">
                {problem}
              </p>
            )}
            {(rowProblems.get(at) ?? []).map((found, place) => (
              <p className="patterns-error" key={`${found.code}-${place}`}>
                {problemText(found)}
              </p>
            ))}
          </div>
        );
      })}
      {mask && maskLeftOut(profile, previous, step, mask) ? <p className="neighbor-types-note">{PERSONAL_DATA_NOT_OFFERED}</p> : null}
      {full.map((on) => (
        <p className="neighbor-types-note" key={on}>
          {sideCapText(on)}
        </p>
      ))}
      <div className="supernode-links">
        <button type="button" className="neighbor-types-link" disabled={block !== undefined} aria-describedby={block === undefined ? undefined : reasonId} onClick={() => dispatch({ type: 'add-condition', index, mask })}>
          {CONDITIONS_COPY.add}
        </button>
      </div>
      {block === undefined ? null : (
        <p className="neighbor-types-note" id={reasonId}>
          {conditionBlockText(block)}
        </p>
      )}
    </fieldset>
  );
}
