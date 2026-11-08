import { useId } from 'react';
import { FILTER_KIND_CHOICES, KIND_LABELS, MAX_FILTER_ROWS, emptyDraft, type Declared, type FilterDraft } from './expand-refine.js';
import {
  ADD_FILTER,
  CLEAR_FILTERS,
  FILTERS_LABEL,
  FILTERS_NONE_OFFERED,
  FILTERS_NOTE,
  FILTER_FROM_LABEL,
  FILTER_KIND_LABEL,
  FILTER_OPERATORS,
  FILTER_OPERATOR_LABEL,
  FILTER_PROPERTY_LABEL,
  FILTER_ROW_UNAVAILABLE,
  FILTER_TO_LABEL,
  FILTER_VALUES_LABEL,
  FILTER_VALUE_LABEL,
  MOST_RECENT,
  RANK_ASCENDING,
  RANK_BY_LABEL,
  RANK_DESCENDING,
  RANK_NOTE_PROPERTY,
  RANK_ORDER_LABEL,
  REMOVE_FILTER,
  filterPropertyOption,
  rankOptionLabel,
} from './expand-copy.js';

/** The choice "Most recent" and the declared properties, as one list: the value of a choice is the side and the property. */
const OBSERVED = 'observed';
const encode = (on: 'neighbor' | 'relationship', property: string): string => `${on}:${property}`;
const decode = (value: string): { readonly on: 'neighbor' | 'relationship'; readonly property: string } | undefined => {
  const at = value.indexOf(':');
  const on = value.slice(0, at);
  return at > 0 && (on === 'neighbor' || on === 'relationship') ? { on, property: value.slice(at + 1) } : undefined;
};

export interface RankChoice {
  readonly on: 'neighbor' | 'relationship';
  readonly property: string;
  readonly order: 'asc' | 'desc';
}

/** The "Rank by" field: the observed time, or a property the mapping declares sortable, with its order. */
export function RankField({ declared, neighborName, rank, onChange, observedNote }: { readonly declared: Declared; readonly neighborName: string; readonly rank: RankChoice | undefined; readonly onChange: (rank: RankChoice | undefined) => void; readonly observedNote: string }) {
  const id = useId();
  const current = rank === undefined ? OBSERVED : encode(rank.on, rank.property);
  return (
    <div className="supernode-field">
      <label className="supernode-label" htmlFor={`${id}-by`}>
        {RANK_BY_LABEL}
      </label>
      <select
        id={`${id}-by`}
        value={current}
        onChange={(event) => {
          const chosen = decode(event.target.value);
          onChange(chosen === undefined ? undefined : { ...chosen, order: rank?.order ?? 'desc' });
        }}
      >
        <option value={OBSERVED}>{MOST_RECENT}</option>
        {declared.neighbor.map((property) => (
          <option key={encode('neighbor', property)} value={encode('neighbor', property)}>
            {rankOptionLabel('neighbor', property, neighborName)}
          </option>
        ))}
        {declared.relationship.map((property) => (
          <option key={encode('relationship', property)} value={encode('relationship', property)}>
            {rankOptionLabel('relationship', property, neighborName)}
          </option>
        ))}
      </select>
      {rank === undefined ? null : (
        <>
          <label className="supernode-label" htmlFor={`${id}-order`}>
            {RANK_ORDER_LABEL}
          </label>
          <select id={`${id}-order`} value={rank.order} onChange={(event) => onChange({ ...rank, order: event.target.value === 'asc' ? 'asc' : 'desc' })}>
            <option value="desc">{RANK_DESCENDING}</option>
            <option value="asc">{RANK_ASCENDING}</option>
          </select>
        </>
      )}
      <span className="neighbor-types-note">{rank === undefined ? observedNote : RANK_NOTE_PROPERTY}</span>
    </div>
  );
}

/** The "Filters" field: one row for each condition, each with the property it is on, an operator, its value or values and the kind of value. */
export function FilterField({
  declared,
  neighborName,
  drafts,
  problems,
  next,
  onChange,
}: {
  readonly declared: Declared;
  readonly neighborName: string;
  readonly drafts: readonly FilterDraft[];
  readonly problems: ReadonlyMap<number, string>;
  /** The ID the next row takes. */
  readonly next: () => number;
  readonly onChange: (drafts: readonly FilterDraft[]) => void;
}) {
  const id = useId();
  const offered = declared.neighbor.length + declared.relationship.length > 0;
  const first = declared.neighbor[0] !== undefined ? ({ on: 'neighbor', property: declared.neighbor[0] } as const) : declared.relationship[0] !== undefined ? ({ on: 'relationship', property: declared.relationship[0] } as const) : undefined;
  const patch = (draft: FilterDraft, change: Partial<FilterDraft>): void => onChange(drafts.map((entry) => (entry.id === draft.id ? { ...entry, ...change } : entry)));
  return (
    <fieldset className="supernode-field supernode-filters">
      <legend className="supernode-label">{FILTERS_LABEL}</legend>
      {!offered && drafts.length === 0 ? <p className="neighbor-types-note">{FILTERS_NONE_OFFERED}</p> : null}
      {drafts.map((draft, index) => {
        const available = draft.on === 'neighbor' ? declared.neighbor.includes(draft.property) : declared.relationship.includes(draft.property);
        const problem = problems.get(draft.id);
        const label = `Filter ${index + 1}`;
        return (
          <div key={draft.id} className="supernode-filter-row" role="group" aria-label={label}>
            <select aria-label={`${label}: ${FILTER_PROPERTY_LABEL}`} value={encode(draft.on, draft.property)} onChange={(event) => { const chosen = decode(event.target.value); if (chosen !== undefined) patch(draft, chosen); }}>
              {available ? null : <option value={encode(draft.on, draft.property)}>{filterPropertyOption(draft.on, draft.property, neighborName)}</option>}
              {declared.neighbor.map((property) => (
                <option key={encode('neighbor', property)} value={encode('neighbor', property)}>
                  {filterPropertyOption('neighbor', property, neighborName)}
                </option>
              ))}
              {declared.relationship.map((property) => (
                <option key={encode('relationship', property)} value={encode('relationship', property)}>
                  {filterPropertyOption('relationship', property, neighborName)}
                </option>
              ))}
            </select>
            <select aria-label={`${label}: ${FILTER_OPERATOR_LABEL}`} value={draft.op} onChange={(event) => patch(draft, { op: event.target.value === 'in' ? 'in' : event.target.value === 'between' ? 'between' : 'eq' })}>
              {(['eq', 'in', 'between'] as const).map((op) => (
                <option key={op} value={op}>
                  {FILTER_OPERATORS[op]}
                </option>
              ))}
            </select>
            {draft.op === 'between' ? (
              <>
                <input className="supernode-number" aria-label={`${label}: ${FILTER_FROM_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={draft.from} onChange={(event) => patch(draft, { from: event.target.value })} />
                <input className="supernode-number" aria-label={`${label}: ${FILTER_TO_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={draft.to} onChange={(event) => patch(draft, { to: event.target.value })} />
              </>
            ) : (
              <input className="supernode-number" aria-label={`${label}: ${draft.op === 'in' ? FILTER_VALUES_LABEL : FILTER_VALUE_LABEL}`} aria-invalid={problem === undefined ? undefined : true} value={draft.text} onChange={(event) => patch(draft, { text: event.target.value })} />
            )}
            <select aria-label={`${label}: ${FILTER_KIND_LABEL}`} value={draft.kind} onChange={(event) => patch(draft, { kind: FILTER_KIND_CHOICES.find((kind) => kind === event.target.value) ?? 'auto' })}>
              {FILTER_KIND_CHOICES.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <button type="button" className="neighbor-types-link" aria-label={`${REMOVE_FILTER} ${index + 1}`} onClick={() => onChange(drafts.filter((entry) => entry.id !== draft.id))}>
              {REMOVE_FILTER}
            </button>
            {available ? null : (
              <p className="neighbor-types-note" role="alert">
                {FILTER_ROW_UNAVAILABLE}
              </p>
            )}
            {problem === undefined ? null : (
              <p className="neighbor-types-note" role="alert" id={`${id}-${draft.id}`}>
                {problem}
              </p>
            )}
          </div>
        );
      })}
      <div className="supernode-links">
        <button type="button" className="neighbor-types-link" disabled={first === undefined || drafts.length >= MAX_FILTER_ROWS} onClick={() => first !== undefined && onChange([...drafts, emptyDraft(next(), first.on, first.property)])}>
          {ADD_FILTER}
        </button>
        {drafts.length === 0 ? null : (
          <button type="button" className="neighbor-types-link" onClick={() => onChange([])}>
            {CLEAR_FILTERS}
          </button>
        )}
      </div>
      {drafts.length === 0 ? null : <p className="neighbor-types-note">{FILTERS_NOTE}</p>}
    </fieldset>
  );
}
