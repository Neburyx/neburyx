import { useEffect, useRef, useState } from 'react';
import { PATTERN_LIMITS, type PatternProblem, type SourceProfile } from '@neburyx/contracts';
import { FILTER_FROM_LABEL, FILTER_KIND_LABEL, FILTER_OPERATORS, FILTER_OPERATOR_LABEL, FILTER_PROPERTY_LABEL, FILTER_ROW_UNAVAILABLE, FILTER_TO_LABEL, FILTER_VALUES_LABEL, FILTER_VALUE_LABEL, filterPropertyOption } from '../../workspace/expand-copy.js';
import { FILTER_KIND_CHOICES, KIND_LABELS, readDraft } from '../../workspace/expand-refine.js';
import { problemText } from '../copy.js';
import { CONDITIONS_TAB, KIND_NAME, arrivingGroup, conditionBlockText, editLabel, groupFull, hiddenInMenu, hiddenOnTab, kindHelp, onArriving, onRelationship, relationshipGroup, removeLabel, valueHelp } from './copy.js';
import { addConditionBlock, conditionSummary, countOn, hiddenPersonalCount, isOffered, nextRowId, offeredProperties, operatorsFor, propertyKind, rowKindFor, rowsOf, type ConditionRow } from './conditions.js';
import { PopupMenu } from './popup-menu.js';
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

interface Editing {
  readonly id: number;
  /** The row as it was when its editing began, or nothing for a row that is new and was never finished. */
  readonly original: ConditionRow | undefined;
}

/**
 * The Conditions tab of a step: two groups, the conditions on the arriving node and on the relationship, each a line with Edit and Remove, and a menu that adds one. A row is edited in place; what is typed takes effect as it is typed, Done closes the form when the
 * row can be read, and Cancel puts the row back as it was. A value is read as Expand reads it.
 */
export function ConditionsTab({ profile, step, steps, index, previous, mask, nodeName, dispatch, rowProblems }: Props) {
  const offered = offeredProperties(profile, previous, step, mask);
  const rows = rowsOf(step);
  const block = addConditionBlock(offered, step, steps);
  const reasonId = `pattern-step-${index}-conditions-reason`;
  const number = index + 1;
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [tried, setTried] = useState<number | undefined>(undefined);
  const form = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<'form' | 'add' | undefined>(undefined);
  const addButton = useRef<HTMLDivElement>(null);
  const hidden = hiddenPersonalCount(profile, step, mask);
  const sides = [
    { on: 'neighbor' as const, group: arrivingGroup(nodeName, countOn(rows, 'neighbor')), label: `Arriving ${nodeName}`, show: step.arrivesAt !== undefined, menu: onArriving(nodeName) },
    { on: 'relationship' as const, group: relationshipGroup(step.relationshipTypes, countOn(rows, 'relationship')), label: step.relationshipTypes.join(' or '), show: step.arrivesAt !== undefined && step.relationshipTypes.length > 0, menu: onRelationship(step.relationshipTypes) },
  ];
  useEffect(() => {
    if (focusAfter.current === 'form') form.current?.querySelector<HTMLElement>('select')?.focus();
    else if (focusAfter.current === 'add') addButton.current?.querySelector<HTMLElement>('button')?.focus();
    focusAfter.current = undefined;
  }, [editing]);

  const finish = (): void => {
    setEditing(undefined);
    setTried(undefined);
    focusAfter.current = 'add';
  };
  const done = (row: ConditionRow): void => {
    if (!readDraft(row).ok) {
      setTried(row.id);
      return;
    }
    finish();
  };
  const cancel = (current: Editing): void => {
    if (current.original === undefined) dispatch({ type: 'remove-condition', index, id: current.id });
    else dispatch({ type: 'change-condition', index, id: current.id, change: { on: current.original.on, property: current.original.property, op: current.original.op, text: current.original.text, from: current.original.from, to: current.original.to, kind: current.original.kind } });
    finish();
  };
  const add = (on: ConditionRow['on'], property: string): void => {
    const id = nextRowId(steps);
    dispatch({ type: 'add-condition', index, mask, on, property });
    setTried(undefined);
    focusAfter.current = 'form';
    setEditing({ id, original: undefined });
  };

  const prefix = `pattern-step-${index}-conditions`;
  /** The ids of the sentences about a row, so that the row is read with them. */
  const describedBy = (row: ConditionRow, at: number, available: boolean): string | undefined => {
    const ids = [...(available ? [] : [`${prefix}-row-${row.id}-unavailable`]), ...(rowProblems.get(at) ?? []).map((_, place) => `${prefix}-row-${row.id}-problem-${place}`)];
    return ids.length === 0 ? undefined : ids.join(' ');
  };
  const rowView = (row: ConditionRow, at: number): React.ReactNode => {
    const label = `Step ${number} condition ${at + 1}`;
    const available = isOffered(row, offered);
    if (editing?.id === row.id) {
      const kind = propertyKind(profile, previous, step, row.on, row.property);
      const operators = operatorsFor(kind);
      const read = row.touched === true || tried === row.id ? readDraft(row) : undefined;
      const problem = read !== undefined && !read.ok ? read.reason : undefined;
      const change = (patch: Partial<ConditionRow>): void => dispatch({ type: 'change-condition', index, id: row.id, change: patch });
      const invalid = problem === undefined ? undefined : true;
      return (
        <div key={row.id} className="condition-form" role="group" aria-label={label} ref={form}>
          <div className="condition-form-pair">
            <label className="condition-field">
              <span className="supernode-label">{FILTER_PROPERTY_LABEL}</span>
              <select
                aria-label={`${label}: ${FILTER_PROPERTY_LABEL}`}
                value={encode(row.on, row.property)}
                onChange={(event) => {
                  const chosen = decode(event.target.value);
                  if (chosen !== undefined) change({ ...chosen, kind: rowKindFor(propertyKind(profile, previous, step, chosen.on, chosen.property)), ...(operatorsFor(propertyKind(profile, previous, step, chosen.on, chosen.property)).includes(row.op) ? {} : { op: 'eq' as const }) });
                }}
              >
                {available ? null : <option value={encode(row.on, row.property)}>{filterPropertyOption(row.on, row.property, nodeName)}</option>}
                {(['neighbor', 'relationship'] as const).flatMap((on) =>
                  offered[on].map((property) => (
                    <option key={encode(on, property)} value={encode(on, property)} disabled={!(on === row.on && property === row.property) && countOn(rows, on) >= PATTERN_LIMITS.conditionsPerElement}>
                      {filterPropertyOption(on, property, nodeName)}
                    </option>
                  )),
                )}
              </select>
            </label>
            <label className="condition-field">
              <span className="supernode-label">{FILTER_OPERATOR_LABEL}</span>
              <select aria-label={`${label}: ${FILTER_OPERATOR_LABEL}`} value={row.op} onChange={(event) => change({ op: operators.find((op) => op === event.target.value) ?? 'eq' })}>
                {operators.map((op) => (
                  <option key={op} value={op}>
                    {FILTER_OPERATORS[op]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="pattern-help">{kindHelp(row.property, kind, operators.map((op) => FILTER_OPERATORS[op]))}</p>
          {kind === undefined || kind === 'unknown' ? (
            <label className="condition-field">
              <span className="supernode-label">{FILTER_KIND_LABEL}</span>
              <select aria-label={`${label}: ${FILTER_KIND_LABEL}`} value={row.kind} onChange={(event) => change({ kind: FILTER_KIND_CHOICES.find((candidate) => candidate === event.target.value) ?? 'auto' })}>
                {FILTER_KIND_CHOICES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {KIND_LABELS[candidate]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {row.op === 'between' ? (
            <div className="condition-form-pair">
              <label className="condition-field">
                <span className="supernode-label">{FILTER_FROM_LABEL}</span>
                <input className="patterns-input" aria-label={`${label}: ${FILTER_FROM_LABEL}`} aria-invalid={invalid} value={row.from} onChange={(event) => change({ from: event.target.value })} />
              </label>
              <label className="condition-field">
                <span className="supernode-label">{FILTER_TO_LABEL}</span>
                <input className="patterns-input" aria-label={`${label}: ${FILTER_TO_LABEL}`} aria-invalid={invalid} value={row.to} onChange={(event) => change({ to: event.target.value })} />
              </label>
            </div>
          ) : (
            <label className="condition-field">
              <span className="supernode-label">{row.op === 'in' ? FILTER_VALUES_LABEL : FILTER_VALUE_LABEL}</span>
              <input className="patterns-input" aria-label={`${label}: ${row.op === 'in' ? FILTER_VALUES_LABEL : FILTER_VALUE_LABEL}`} aria-invalid={invalid} value={row.text} onChange={(event) => change({ text: event.target.value })} />
            </label>
          )}
          <p className="pattern-help">{valueHelp(row.kind === 'auto' ? kind : row.kind, row.op === 'between')}</p>
          {problem === undefined ? null : (
            <p className="patterns-error" role="alert">
              {problem}
            </p>
          )}
          {available ? null : (
            <p className="patterns-error" role="alert">
              {FILTER_ROW_UNAVAILABLE}
            </p>
          )}
          {(rowProblems.get(rows.findIndex((candidate) => candidate.id === row.id)) ?? []).map((found, place) => (
            <p className="patterns-error" key={`${found.code}-${place}`}>
              {problemText(found)}
            </p>
          ))}
          <div className="condition-form-actions">
            <button type="button" className="primary" onClick={() => done(row)}>
              {CONDITIONS_TAB.done}
            </button>
            <button type="button" className="secondary" onClick={() => cancel(editing)}>
              {CONDITIONS_TAB.cancel}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div key={row.id} className="condition-row" role="group" aria-label={label} aria-describedby={describedBy(row, at, available)} data-unavailable={available ? undefined : 'true'}>
        <div className="condition-row-text">
          <span className="condition-row-on">{row.on === 'neighbor' ? nodeName : CONDITIONS_TAB.relationship}</span>
          <span>{conditionSummary(row)}</span>
        </div>
        <button type="button" className="condition-icon" aria-label={editLabel(conditionSummary(row))} onClick={() => ((focusAfter.current = 'form'), setEditing({ id: row.id, original: row }))}>
          <span aria-hidden="true">✎</span>
        </button>
        <button type="button" className="condition-icon" aria-label={removeLabel(conditionSummary(row))} onClick={() => dispatch({ type: 'remove-condition', index, id: row.id })}>
          <span aria-hidden="true">×</span>
        </button>
        {available ? null : (
          <p className="patterns-error condition-row-note" role="alert" id={`${prefix}-row-${row.id}-unavailable`}>
            {FILTER_ROW_UNAVAILABLE}
          </p>
        )}
        {(rowProblems.get(at) ?? []).map((found, place) => (
          <p className="patterns-error condition-row-note" key={`${found.code}-${place}`} id={`${prefix}-row-${row.id}-problem-${place}`}>
            {problemText(found)}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="patterns-conditions">
      {sides.map((side) => {
        if (!side.show) return null;
        const mine = rows.map((row, at) => ({ row, at })).filter(({ row }) => row.on === side.on);
        const full = countOn(rows, side.on) >= PATTERN_LIMITS.conditionsPerElement && offered[side.on].length > 0;
        return (
          <div key={side.on} className="patterns-field" role="group" aria-label={side.group}>
            <span className="supernode-label">{side.group}</span>
            {mine.map(({ row, at }) => rowView(row, at))}
            {full ? <p className="pattern-help">{groupFull(side.label)}</p> : null}
          </div>
        );
      })}
      <div ref={addButton}>
        <PopupMenu button={CONDITIONS_TAB.add} label={CONDITIONS_TAB.addMenu} disabled={block !== undefined} describedBy={block === undefined ? undefined : reasonId}>
          {(close) => (
            <>
              {sides.map((side) =>
                !side.show || offered[side.on].length === 0 ? null : (
                  <div key={side.on} role="group" aria-label={side.menu}>
                    <p className="popup-menu-heading">{side.menu}</p>
                    {offered[side.on].map((property) => {
                      const kind = propertyKind(profile, previous, step, side.on, property);
                      const blocked = countOn(rows, side.on) >= PATTERN_LIMITS.conditionsPerElement;
                      return (
                        <div
                          key={property}
                          role="menuitem"
                          tabIndex={-1}
                          aria-disabled={blocked ? true : undefined}
                          className="popup-menu-item"
                          onClick={() => {
                            if (blocked) return;
                            close();
                            add(side.on, property);
                          }}
                          onKeyDown={(event) => {
                            if ((event.key === 'Enter' || event.key === ' ') && !blocked) {
                              event.preventDefault();
                              close();
                              add(side.on, property);
                            }
                          }}
                        >
                          <span className="popup-menu-type">{property}</span>
                          {kind === undefined || kind === 'unknown' ? null : <span className="popup-menu-lead">{KIND_NAME[kind] ?? kind}</span>}
                        </div>
                      );
                    })}
                  </div>
                ),
              )}
              {hidden > 0 ? <p className="popup-menu-note">{hiddenInMenu(hidden)}</p> : null}
            </>
          )}
        </PopupMenu>
      </div>
      {block === undefined ? null : (
        <p className="pattern-help" id={reasonId}>
          {conditionBlockText(block)}
        </p>
      )}
      {hidden > 0 ? (
        <div className="patterns-state" data-tone="notice" role="note">
          <p>{CONDITIONS_TAB.hiddenTitle}</p>
          <p>{hiddenOnTab(hidden)}</p>
        </div>
      ) : null}
      {editing === undefined ? null : <p className="pattern-help">{CONDITIONS_TAB.valueTypes}</p>}
    </div>
  );
}
