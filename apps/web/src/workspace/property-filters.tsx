import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { canonicalNumberText, type FilterKind } from '@neburyx/contracts';
import { useProfile } from '../canvas/profile-context.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { filteredRelationshipsOf } from '../state/filtered-relationships.js';
import { mappedPropertiesOf } from '../state/mapped-properties.js';
import { bounded, choicesOf, isRangeKind, loadedRange, MAX_CHOSEN_VALUES, readBound, type ChoiceCondition, type ChoiceKind, type ConditionOn, type Filterable, type RangeCondition, type RangeKind } from '../state/property-filter.js';
import { useStoreSelector } from '../state/store.js';
import { PROPERTY_FILTER_COPY, PROPERTY_RANGE_COPY } from './filters-copy.js';
import { boundText, rangeText } from './range-text.js';

type Declared = FilterKind | 'unknown';

/** How a property is filtered, from the kind the mapping declares: a choice of values, or a range (which a later control draws). */
const controlOf = (declared: Declared): 'choice' | 'range' => (declared === 'text' || declared === 'boolean' || declared === 'unknown' ? 'choice' : 'range');

function choiceKindOf(declared: Declared, observed: ChoiceKind | undefined): ChoiceKind | undefined {
  if (declared === 'text' || declared === 'boolean') return declared;
  return declared === 'unknown' ? observed : undefined;
}

interface BlockProps {
  readonly on: ConditionOn;
  /** The loaded entities, or relationships, of the type. */
  readonly items: readonly Filterable[];
  readonly typeName: string;
  readonly type: string;
  readonly property: string;
  readonly declared: Declared;
  readonly condition: ChoiceCondition | RangeCondition | undefined;
  readonly disabled: boolean;
  /** The property is personal data: its filter lasts for this session only and is never saved. */
  readonly personal: boolean;
}

/** The choice of values of one property of one entity type: a button that shows what is chosen and opens the list of the loaded values. */
function ChoiceBlock({ on, items, typeName, type, property, declared, condition, disabled, personal }: BlockProps) {
  const id = useId();
  const state = useClientState();
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const [refused, setRefused] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const declaredKind = declared === 'text' || declared === 'boolean' ? declared : undefined;
  const choices = useMemo(() => choicesOf(items, property, declaredKind), [items, property, declaredKind]);
  const kind = choiceKindOf(declared, choices.observed);
  const label = PROPERTY_FILTER_COPY.label(typeName, property, personal ? PROPERTY_FILTER_COPY.personalSuffix : PROPERTY_FILTER_COPY.suffix);
  const chosen = condition?.op === 'in' ? condition.values : [];
  const offered = kind === undefined || choices.masked || choices.values.length === 0 ? [] : choices.values;
  const listed = [...offered, ...chosen.filter((value) => !offered.includes(value))];
  const shown = find.trim() === '' ? listed : listed.filter((value) => value.toLowerCase().includes(find.trim().toLowerCase()));
  const identity = { on, type, property } as const;
  const choose = (value: string): void => {
    if (kind === undefined) return;
    const next = chosen.includes(value) ? chosen.filter((candidate) => candidate !== value) : [...chosen, value];
    if (next.length > MAX_CHOSEN_VALUES) {
      setRefused(true);
      return;
    }
    setRefused(false);
    const ordered = listed.filter((candidate) => next.includes(candidate));
    state.setPropertyCondition(identity, ordered.length === 0 ? undefined : { ...identity, kind, op: 'in', values: ordered });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    opener.current?.focus();
  };
  if (kind === undefined || choices.masked || (listed.length === 0 && condition === undefined)) {
    return (
      <div className="filters-section">
        <span className="supernode-label">{label}</span>
        <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.noValues}</p>
      </div>
    );
  }
  return (
    <div className="filters-section" onKeyDown={onKeyDown}>
      <span className="supernode-label" id={`${id}-label`}>
        {label}
      </span>
      <button type="button" ref={opener} className="property-filter-button" aria-labelledby={`${id}-label ${id}-closed`} aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled} onClick={() => setOpen(!open)}>
        <span id={`${id}-closed`}>{chosen.length === 0 ? PROPERTY_FILTER_COPY.any : chosen.join(', ')}</span>
      </button>
      {open ? (
        <div id={`${id}-list`} role="group" aria-label={label} className="property-filter-list">
          <input type="search" className="property-filter-find" aria-label={PROPERTY_FILTER_COPY.find} placeholder={PROPERTY_FILTER_COPY.find} value={find} onChange={(event) => setFind(event.target.value)} />
          <ul className="neighbor-types-list">
            {shown.map((value) => (
              <li key={value} className="neighbor-types-item">
                <button type="button" role="checkbox" aria-checked={chosen.includes(value)} className="neighbor-types-row" onClick={() => choose(value)}>
                  <span className="neighbor-types-check" aria-hidden="true" />
                  <span className="menu-label">{offered.includes(value) ? value : `${value} (${PROPERTY_FILTER_COPY.notLoaded})`}</span>
                </button>
              </li>
            ))}
          </ul>
          {refused ? (
            <p className="neighbor-types-note" role="status">
              {PROPERTY_FILTER_COPY.tooMany(MAX_CHOSEN_VALUES)}
            </p>
          ) : null}
        </div>
      ) : null}
      {condition !== undefined && choices.missing > 0 ? <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.noValueFor(choices.missing, property)}</p> : null}
      {choices.unusable > 0 ? <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.unusable(choices.unusable)}</p> : null}
    </div>
  );
}

/** The range of one ordered property of one entity type: a button that shows the bounds and opens two fields. */
function RangeBlock({ on, items, typeName, type, property, declared, condition, disabled, personal }: BlockProps) {
  const id = useId();
  const state = useClientState();
  const kind = declared as RangeKind;
  const held = condition?.op === 'between' ? condition : undefined;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState({ from: held?.from ?? '', to: held?.to ?? '' });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // what the fields last set, so a change of the condition from elsewhere (Reset, a restore, a mapping drop) puts its bounds in the fields and typing does not
  const applied = useRef({ from: held?.from ?? '', to: held?.to ?? '' });
  useEffect(() => {
    const now = { from: held?.from ?? '', to: held?.to ?? '' };
    if (now.from === applied.current.from && now.to === applied.current.to) return;
    applied.current = now;
    setText(now);
    setProblem(undefined);
  }, [held?.from, held?.to]);
  const choices = useMemo(() => choicesOf(items, property), [items, property]);
  const opener = useRef<HTMLButtonElement>(null);
  const loaded = useMemo(() => loadedRange(items, property, kind), [items, property, kind]);
  const label = PROPERTY_FILTER_COPY.label(typeName, property, personal ? PROPERTY_FILTER_COPY.personalSuffix : PROPERTY_FILTER_COPY.suffix);
  const identity = { on, type, property } as const;
  const apply = (next: { readonly from: string; readonly to: string }): void => {
    setText(next);
    const read = (value: string): { readonly ok: true; readonly text: string | undefined } | { readonly ok: false } => {
      if (value.trim() === '') return { ok: true, text: undefined };
      const bound = readBound(kind, value);
      if (!bound.ok) return bound;
      return { ok: true, text: kind === 'number' ? (canonicalNumberText(bound.text) ?? bound.text) : bound.text };
    };
    const from = read(next.from);
    const to = read(next.to);
    if (!from.ok || !to.ok) {
      setProblem(PROPERTY_RANGE_COPY.unreadable(kind));
      return;
    }
    if (from.text !== undefined && to.text !== undefined && bounded(kind, from.text, to.text)) {
      setProblem(PROPERTY_RANGE_COPY.fromAfterTo);
      return;
    }
    setProblem(undefined);
    applied.current = { from: from.text ?? '', to: to.text ?? '' };
    state.setPropertyCondition(identity, from.text === undefined && to.text === undefined ? undefined : { ...identity, kind, op: 'between', from: from.text, to: to.text });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    opener.current?.focus();
  };
  if (choices.masked) {
    return (
      <div className="filters-section">
        <span className="supernode-label">{label}</span>
        <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.noValues}</p>
      </div>
    );
  }
  return (
    <div className="filters-section" onKeyDown={onKeyDown}>
      <span className="supernode-label" id={`${id}-label`}>
        {label}
      </span>
      <button type="button" ref={opener} className="property-filter-button" aria-labelledby={`${id}-label ${id}-closed`} aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled} onClick={() => setOpen(!open)}>
        <span id={`${id}-closed`}>{rangeText(kind, held?.from, held?.to)}</span>
      </button>
      {open ? (
        <div id={`${id}-list`} role="group" aria-label={label} className="property-filter-list">
          <label className="supernode-label" htmlFor={`${id}-from`}>
            {PROPERTY_RANGE_COPY.from}
          </label>
          <input id={`${id}-from`} inputMode={kind === 'number' ? 'decimal' : 'text'} value={text.from} aria-invalid={problem !== undefined} aria-describedby={problem === undefined ? undefined : `${id}-problem`} onChange={(event) => apply({ from: event.target.value, to: text.to })} />
          <label className="supernode-label" htmlFor={`${id}-to`}>
            {PROPERTY_RANGE_COPY.to}
          </label>
          <input id={`${id}-to`} inputMode={kind === 'number' ? 'decimal' : 'text'} value={text.to} aria-invalid={problem !== undefined} aria-describedby={problem === undefined ? undefined : `${id}-problem`} onChange={(event) => apply({ from: text.from, to: event.target.value })} />
          {problem === undefined ? null : (
            <p id={`${id}-problem`} className="neighbor-types-note" role="status">
              {problem}
            </p>
          )}
          {loaded === undefined ? null : (
            <>
              <p className="neighbor-types-note">{PROPERTY_RANGE_COPY.lowest(boundText(kind, loaded.lowest))}</p>
              <p className="neighbor-types-note">{PROPERTY_RANGE_COPY.highest(boundText(kind, loaded.highest))}</p>
            </>
          )}
        </div>
      ) : null}
      {held !== undefined && choices.missing > 0 ? <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.noValueFor(choices.missing, property)}</p> : null}
    </div>
  );
}

interface Block {
  readonly on: ConditionOn;
  readonly type: string;
  readonly typeName: string;
  readonly property: string;
  readonly declared: Declared;
  readonly items: readonly Filterable[];
  readonly personal: boolean;
}

/**
 * The properties the panel lists a block for: each filterable property, not personal data and filtered by a choice or a range, of each entity type that has a loaded entity and of each relationship type that has a loaded stored relationship
 * (a derived or an aggregate relationship carries no properties to judge).
 */
export function usePropertyBlocks(): readonly Block[] {
  const profile = useProfile();
  const graph = useLoadedGraph();
  const state = useClientState();
  const masking = useStoreSelector(state.mask, (current) => current);
  const mapped = useMemo(() => (profile === undefined ? undefined : mappedPropertiesOf(profile)), [profile]);
  return useMemo(() => {
    if (profile === undefined || mapped === undefined) return [];
    const blocks: Block[] = [];
    for (const type of profile.entityTypes) {
      const items = graph.nodes.filter((node) => node.ref.entityType === type.type);
      if (items.length === 0) continue;
      for (const property of type.filterable) {
        const personal = type.pii.includes(property);
        if (!personal || !masking) blocks.push({ on: 'entity', type: type.type, typeName: type.displayName, property, declared: (type.filterKinds?.[property] ?? 'unknown') as Declared, items, personal });
      }
    }
    for (const [type, held] of Object.entries(mapped.relationship)) {
      const items = graph.edges.filter((edge) => edge.type === type && edge.semantics !== 'derived' && !('aggregate' in edge.ref));
      if (items.length === 0) continue;
      for (const property of held.filterable) blocks.push({ on: 'relationship', type, typeName: type, property, declared: (held.kinds[property] ?? 'unknown') as Declared, items, personal: false });
    }
    return blocks.filter((block) => controlOf(block.declared) === 'choice' || isRangeKind(block.declared));
  }, [profile, mapped, graph, masking]);
}

/** The property blocks of the Filters panel. */
export function PropertyBlocks({ blocks }: { readonly blocks: readonly Block[] }) {
  const state = useClientState();
  const graph = useLoadedGraph();
  const filter = useStoreSelector(state.presentation.view, (current) => current.typeFilter);
  const unjudged = filteredRelationshipsOf(graph, filter).unjudged;
  return (
    <>
      {blocks.map(({ on, type, typeName, property, declared, items, personal }) => {
        const Block = controlOf(declared) === 'range' ? RangeBlock : ChoiceBlock;
        const off = on === 'entity' ? filter.offEntityTypes.has(type) : filter.offRelationshipTypes.has(type);
        return <Block key={`${on}\u0000${type}\u0000${property}`} on={on} items={items} typeName={typeName} type={type} property={property} declared={declared} condition={filter.properties.find((held) => held.on === on && held.type === type && held.property === property)} disabled={off} personal={personal} />;
      })}
      {unjudged === 0 ? null : <p className="neighbor-types-note">{PROPERTY_FILTER_COPY.unjudged(unjudged)}</p>}
    </>
  );
}
