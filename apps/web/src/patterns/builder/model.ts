import { PATTERN_LIMITS, type PatternDefinition, type SourceProfile } from '@neburyx/contracts';
import { addConditionBlock, countOn, firstChoice, isOffered, nextRowId, offeredProperties, propertyKind, readRows, readWindow, rowKindFor, rowsOf, windowOf, windowReach, type ConditionRow, type WindowDraft } from './conditions.js';

export type Direction = 'out' | 'in' | 'both';

export const DIRECTIONS: readonly Direction[] = ['out', 'in', 'both'];

/** One step as the person has chosen it so far; a field is absent until it is chosen. */
export interface StepDraft {
  readonly direction?: Direction;
  readonly arrivesAt?: string;
  readonly relationshipTypes: readonly string[];
  /** The conditions on the step's node and relationship, in the order typed; they go with the step. */
  readonly conditions?: readonly ConditionRow[];
  readonly window?: WindowDraft;
}

export interface Draft {
  readonly anchorType?: string;
  readonly steps: readonly StepDraft[];
}

export const EMPTY_DRAFT: Draft = { steps: [] };

type Row = SourceProfile['relationshipTypes'][number];

export const joins = (row: Row, from: string, to: string, direction: Direction): boolean => {
  const forward = row.from === from && row.to === to;
  const backward = row.to === from && row.from === to;
  return direction === 'out' ? forward : direction === 'in' ? backward : forward || backward;
};

/** The node types the mapping reaches from a node type in a direction, each once, in the profile's order. */
export function arrivalTypes(profile: SourceProfile, from: string, direction: Direction): readonly string[] {
  const reached = new Set<string>();
  for (const row of profile.relationshipTypes) {
    if (direction !== 'in' && row.from === from) reached.add(row.to);
    if (direction !== 'out' && row.to === from) reached.add(row.from);
  }
  return profile.entityTypes.map((type) => type.type).filter((type) => reached.has(type));
}

/** The relationship types that join one node type to another in a direction, each once however many rows it has. */
export function relationshipChoices(profile: SourceProfile, from: string, to: string, direction: Direction): readonly string[] {
  const found: string[] = [];
  for (const row of profile.relationshipTypes) if (joins(row, from, to, direction) && !found.includes(row.type)) found.push(row.type);
  return found;
}

export interface TypeOption {
  readonly type: string;
  /** The node type the relationship type leads to from the step's start. */
  readonly arrival: string;
  /** Whether the mapping gives this relationship type an observed time, which a date window can filter. */
  readonly dated: boolean;
}

/** The relationship types a step may take, each with the node type it leads to and whether it has a date: from the step's start in its direction, and only to the arrival type once one is chosen. */
export function typeOptions(profile: SourceProfile, from: string, direction: Direction, arrival: string | undefined): readonly TypeOption[] {
  const found = new Map<string, TypeOption>();
  const add = (row: Row, to: string): void => {
    if (arrival !== undefined && to !== arrival) return;
    const key = `${row.type}\u0000${to}`;
    const held = found.get(key);
    found.set(key, { type: row.type, arrival: to, dated: (held?.dated ?? false) || row.observedAt !== null });
  };
  for (const row of profile.relationshipTypes) {
    if (direction !== 'in' && row.from === from) add(row, row.to);
    if (direction !== 'out' && row.to === from) add(row, row.from);
  }
  return [...found.values()];
}

/** Whether any relationship type of the mapping touches a node type, in any direction. */
export const hasAnyRelationship = (profile: SourceProfile, type: string): boolean => profile.relationshipTypes.some((row) => row.from === type || row.to === type);

export const hasConditions = (step: StepDraft): boolean => rowsOf(step).length > 0;

export const isComplete = (step: StepDraft): boolean => step.direction !== undefined && step.arrivesAt !== undefined && step.relationshipTypes.length > 0;

/** The node type a step starts from: the start type for the first step, the arrival type of the step before for the others. */
export const previousTypeOf = (draft: Draft, index: number): string | undefined => (index === 0 ? draft.anchorType : draft.steps[index - 1]?.arrivesAt);

/** The node type the pattern has reached so far. */
export const lastTypeOf = (draft: Draft): string | undefined => (draft.steps.length === 0 ? draft.anchorType : draft.steps[draft.steps.length - 1]?.arrivesAt);

export type Action =
  | { readonly type: 'start'; readonly anchorType: string | undefined }
  | { readonly type: 'add' }
  | { readonly type: 'direction'; readonly index: number; readonly direction: Direction | undefined }
  | { readonly type: 'arrives'; readonly index: number; readonly arrivesAt: string | undefined }
  | { readonly type: 'toggle'; readonly index: number; readonly relationshipType: string }
  | { readonly type: 'remove'; readonly index?: number }
  /** Puts the draft back as it was before the change that broke it. */
  | { readonly type: 'undo' }
  | { readonly type: 'add-condition'; readonly index: number; readonly mask: boolean; /** The property the row starts on; the first one offered when none is named. */ readonly on?: ConditionRow['on']; readonly property?: string }
  | { readonly type: 'change-condition'; readonly index: number; readonly id: number; readonly change: Partial<ConditionRow> }
  | { readonly type: 'remove-condition'; readonly index: number; readonly id: number }
  | { readonly type: 'window'; readonly index: number; readonly window: WindowDraft };

/** The draft as it was before the change that broke later parts, and where that change was made: a change leaves what it breaks in place and marked, and this puts it all back. */
export interface Undo {
  readonly draft: Draft;
  readonly changed: 'start' | number;
}

export interface BuilderState {
  readonly draft: Draft;
  readonly undo?: Undo;
}

export const INITIAL: BuilderState = { draft: EMPTY_DRAFT };

/** The changes that can leave a later part of the pattern unfollowed: the ones to the start, a step's direction, arrival or relationship types, and removing a step. */
const changesLink = (action: Action): boolean => action.type === 'start' || action.type === 'direction' || action.type === 'arrives' || action.type === 'toggle' || action.type === 'remove';
const placeOf = (action: Action, draft: Draft): 'start' | number => (action.type === 'start' ? 'start' : action.type === 'remove' ? (action.index ?? draft.steps.length - 1) : action.type === 'direction' || action.type === 'arrives' || action.type === 'toggle' ? action.index : 'start');

/**
 * Applies a change to the draft. A change never removes anything the person built: what the mapping then does not follow is kept and marked (`breaksOf`), and the state keeps the draft as it was before the first change that broke something,
 * so that `undo` puts it all back; once nothing is broken any more the undo is gone.
 */
export function reduce(profile: SourceProfile, state: BuilderState, action: Action): BuilderState {
  if (action.type === 'undo') return state.undo === undefined ? state : { draft: state.undo.draft };
  const next = apply(state, action, profile);
  if (next === state) return state;
  if (breaksOf(profile, next.draft, false).length === 0) return { draft: next.draft };
  if (!changesLink(action)) return state.undo === undefined ? { draft: next.draft } : { draft: next.draft, undo: state.undo };
  const undo = state.undo ?? (breaksOf(profile, state.draft, false).length === 0 ? { draft: state.draft, changed: placeOf(action, state.draft) } : undefined);
  return undo === undefined ? { draft: next.draft } : { draft: next.draft, undo };
}

function apply(state: BuilderState, action: Exclude<Action, { readonly type: 'undo' }>, profile: SourceProfile): BuilderState {
  const { draft } = state;
  switch (action.type) {
    case 'start':
      return { draft: { ...draft, anchorType: action.anchorType } };
    case 'add':
      return { draft: { ...draft, steps: [...draft.steps, { relationshipTypes: [] }] } };
    case 'remove': {
      const index = action.index ?? draft.steps.length - 1;
      if (index < 0 || index >= draft.steps.length) return state;
      return { draft: { ...draft, steps: draft.steps.filter((_, at) => at !== index) } };
    }
    case 'direction':
    case 'arrives':
    case 'toggle': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      let next: StepDraft = step;
      if (action.type === 'direction') next = { ...step, direction: action.direction };
      else if (action.type === 'arrives') next = { ...step, arrivesAt: action.arrivesAt };
      else {
        const checked = step.relationshipTypes.includes(action.relationshipType);
        if (!checked && step.relationshipTypes.length >= PATTERN_LIMITS.relationshipTypesPerStep) return state;
        next = { ...step, relationshipTypes: checked ? step.relationshipTypes.filter((type) => type !== action.relationshipType) : [...step.relationshipTypes, action.relationshipType] };
      }
      return { draft: withStep(draft, action.index, next) };
    }
    case 'add-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      const offered = offeredProperties(profile, previousTypeOf(draft, action.index), step, action.mask);
      const named = action.on !== undefined && action.property !== undefined && offered[action.on].includes(action.property) && countOn(rowsOf(step), action.on) < PATTERN_LIMITS.conditionsPerElement ? { on: action.on, property: action.property } : undefined;
      const choice = addConditionBlock(offered, step, draft.steps) === undefined ? (named ?? firstChoice(offered, step)) : undefined;
      if (choice === undefined) return state;
      const kind = rowKindFor(propertyKind(profile, previousTypeOf(draft, action.index), step, choice.on, choice.property));
      const row: ConditionRow = { id: nextRowId(draft.steps), on: choice.on, property: choice.property, op: 'eq', text: '', from: '', to: '', kind };
      return { draft: withStep(draft, action.index, { ...step, conditions: [...rowsOf(step), row] }) };
    }
    case 'change-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      const rows = rowsOf(step).map((row) => (row.id === action.id ? { ...row, ...action.change, touched: true } : row));
      return { draft: withStep(draft, action.index, { ...step, conditions: rows }) };
    }
    case 'remove-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      return { draft: withStep(draft, action.index, { ...step, conditions: rowsOf(step).filter((row) => row.id !== action.id) }) };
    }
    case 'window': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      return { draft: withStep(draft, action.index, { ...step, window: action.window }) };
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

const withStep = (draft: Draft, index: number, step: StepDraft): Draft => ({ ...draft, steps: draft.steps.map((candidate, at) => (at === index ? step : candidate)) });

/** A part of a step that the mapping does not follow as the draft stands: kept as the person left it, and marked. */
export type Break =
  | { readonly kind: 'types-leave'; readonly step: number; readonly part: 'link'; readonly types: readonly string[]; readonly from: string }
  | { readonly kind: 'types-lead'; readonly step: number; readonly part: 'link'; readonly types: readonly string[]; readonly arrival: string }
  | { readonly kind: 'arrival'; readonly step: number; readonly part: 'link'; readonly from: string; readonly arrival: string }
  | { readonly kind: 'condition'; readonly step: number; readonly part: 'conditions'; readonly row: ConditionRow; /** How many conditions of the step are on this property of this side and are not offered: they are said once. */ readonly rows: number; readonly arrival: string; readonly types: readonly string[] }
  | { readonly kind: 'window'; readonly step: number; readonly part: 'window' };

type MappingRow = SourceProfile['relationshipTypes'][number];

const leaves = (row: MappingRow, from: string, direction: Direction): boolean => (direction === 'out' ? row.from === from : direction === 'in' ? row.to === from : row.from === from || row.to === from);

/** The node types a relationship type of the mapping leads to from a node type in a direction. */
export function leadsTo(profile: SourceProfile, type: string, from: string, direction: Direction): readonly string[] {
  const found: string[] = [];
  for (const row of profile.relationshipTypes) {
    if (row.type !== type) continue;
    if (direction !== 'in' && row.from === from && !found.includes(row.to)) found.push(row.to);
    if (direction !== 'out' && row.to === from && !found.includes(row.from)) found.push(row.from);
  }
  return found;
}

/**
 * Every part of the draft that the mapping does not follow, in the order of the steps: a relationship type that does not leave the step's start, one that leads somewhere else than the chosen arrival, an arrival the direction does not reach,
 * a condition on a property the step no longer offers, and a window on a step none of whose chosen types has a date. Nothing is changed for the person: this only says where.
 */
export function breaksOf(profile: SourceProfile, draft: Draft, mask: boolean): readonly Break[] {
  const found: Break[] = [];
  draft.steps.forEach((step, index) => {
    const from = previousTypeOf(draft, index);
    if (from === undefined) return;
    const { direction, arrivesAt: arrival } = step;
    if (direction !== undefined) {
      if (arrival !== undefined && !arrivalTypes(profile, from, direction).includes(arrival)) found.push({ kind: 'arrival', step: index, part: 'link', from, arrival });
      const noLeave = step.relationshipTypes.filter((type) => !profile.relationshipTypes.some((row) => row.type === type && leaves(row, from, direction)));
      if (noLeave.length > 0) found.push({ kind: 'types-leave', step: index, part: 'link', types: noLeave, from });
      if (arrival !== undefined) {
        const noLead = step.relationshipTypes.filter((type) => !noLeave.includes(type) && !profile.relationshipTypes.some((row) => row.type === type && joins(row, from, arrival, direction)));
        if (noLead.length > 0) found.push({ kind: 'types-lead', step: index, part: 'link', types: noLead, arrival });
      }
    }
    if (arrival !== undefined) {
      const offered = offeredProperties(profile, from, step, mask);
      for (const row of rowsOf(step)) {
        if (row.on === 'relationship' && step.relationshipTypes.length === 0) continue;
        if (isOffered(row, offered)) continue;
        const same = found.findIndex((held) => held.kind === 'condition' && held.step === index && held.row.on === row.on && held.row.property === row.property);
        const held = found[same];
        if (held !== undefined && held.kind === 'condition') found[same] = { ...held, rows: held.rows + 1 };
        else found.push({ kind: 'condition', step: index, part: 'conditions', row, rows: 1, arrival, types: step.relationshipTypes });
      }
    }
    if (windowOf(step).kind !== 'none' && direction !== undefined && arrival !== undefined && step.relationshipTypes.length > 0 && windowReach(profile, from, step).appliesTo.length === 0) found.push({ kind: 'window', step: index, part: 'window' });
  });
  return found;
}

/**
 * The definition the server is asked about: only when the start type and every step are complete, every condition row is read and still offered for its step, and the window is read. A definition held back is never shown as valid or invalid.
 */
export function toDefinition(draft: Draft, profile: SourceProfile, mask: boolean): PatternDefinition | undefined {
  if (draft.anchorType === undefined || draft.steps.length === 0) return undefined;
  if (breaksOf(profile, draft, mask).length > 0) return undefined;
  const steps: PatternDefinition['steps'] = [];
  for (const [index, step] of draft.steps.entries()) {
    if (step.direction === undefined || step.arrivesAt === undefined || step.relationshipTypes.length === 0) return undefined;
    const offered = offeredProperties(profile, previousTypeOf(draft, index), step, mask);
    if (rowsOf(step).some((row) => !isOffered(row, offered))) return undefined;
    const read = readRows(rowsOf(step));
    if (read.problems.size > 0) return undefined;
    const window = readWindow(windowOf(step));
    if (!window.ok) return undefined;
    steps.push({
      relationshipTypes: [...step.relationshipTypes],
      direction: step.direction,
      arrivesAt: step.arrivesAt,
      ...(read.filters.length === 0 ? {} : { conditions: [...read.filters] }),
      ...(window.window === undefined ? {} : { window: window.window }),
    });
  }
  return { anchorType: draft.anchorType, steps };
}

/** How many steps a pattern may have on the source: its own limit, never above the contract's. */
export const stepLimitOf = (maxHops: number | undefined): number => Math.min(maxHops ?? PATTERN_LIMITS.steps, PATTERN_LIMITS.steps);

export type AddStepBlock = { readonly kind: 'start' } | { readonly kind: 'incomplete' } | { readonly kind: 'limit'; readonly limit: number } | { readonly kind: 'dead-end'; readonly type: string };

/** Why Add step is disabled, or nothing when a step can be added. */
export function addStepBlock(profile: SourceProfile, draft: Draft, limit: number): AddStepBlock | undefined {
  if (draft.anchorType === undefined) return { kind: 'start' };
  const last = draft.steps[draft.steps.length - 1];
  if (last !== undefined && !isComplete(last)) return { kind: 'incomplete' };
  if (draft.steps.length >= limit) return { kind: 'limit', limit };
  const type = lastTypeOf(draft);
  if (type !== undefined && !hasAnyRelationship(profile, type)) return { kind: 'dead-end', type };
  return undefined;
}
