import { PATTERN_LIMITS, type PatternDefinition, type SourceProfile } from '@neburyx/contracts';
import { NO_WINDOW, addConditionBlock, carryingRows, firstChoice, isOffered, nextRowId, offeredProperties, readRows, readWindow, rowsOf, windowOf, windowReach, type ConditionRow, type WindowDraft } from './conditions.js';

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

/** Whether any relationship type of the mapping touches a node type, in any direction. */
export const hasAnyRelationship = (profile: SourceProfile, type: string): boolean => profile.relationshipTypes.some((row) => row.from === type || row.to === type);

export const isComplete = (step: StepDraft): boolean => step.direction !== undefined && step.arrivesAt !== undefined && step.relationshipTypes.length > 0;

/** The node type a step starts from: the start type for the first step, the arrival type of the step before for the others. */
export const previousTypeOf = (draft: Draft, index: number): string | undefined => (index === 0 ? draft.anchorType : draft.steps[index - 1]?.arrivesAt);

/** The node type the pattern has reached so far. */
export const lastTypeOf = (draft: Draft): string | undefined => (draft.steps.length === 0 ? draft.anchorType : draft.steps[draft.steps.length - 1]?.arrivesAt);

const stepStillJoins = (profile: SourceProfile, from: string | undefined, step: StepDraft): boolean => {
  if (from === undefined || step.direction === undefined || step.arrivesAt === undefined) return false;
  if (!arrivalTypes(profile, from, step.direction).includes(step.arrivesAt)) return false;
  const allowed = relationshipChoices(profile, from, step.arrivesAt, step.direction);
  return step.relationshipTypes.every((type) => allowed.includes(type));
};

export interface Repaired {
  readonly draft: Draft;
  /** How many steps were removed because they no longer follow from the step before. */
  readonly removed: number;
}

/**
 * Keeps the chain one the mapping can follow after a change. The first step the change touched keeps what still joins (its arrival type while the mapping reaches it, its checked relationship types while they join);
 * every later step is kept only while all of its own choices still join from the step before it, and the first one that does not is removed with those after it.
 */
export function repair(profile: SourceProfile, draft: Draft, changed: number): Repaired {
  const steps: StepDraft[] = [];
  for (let index = 0; index < draft.steps.length; index += 1) {
    const step = draft.steps[index];
    if (step === undefined) break;
    const from = index === 0 ? draft.anchorType : steps[index - 1]?.arrivesAt;
    if (index < changed) {
      steps.push(step);
      continue;
    }
    if (index === changed) {
      const direction = step.direction;
      if (from === undefined || direction === undefined) {
        steps.push({ ...step, arrivesAt: undefined, relationshipTypes: [] });
        continue;
      }
      const arrival = step.arrivesAt;
      const carried = { ...(step.conditions === undefined ? {} : { conditions: step.conditions }), ...(step.window === undefined ? {} : { window: step.window }) };
      if (arrival === undefined) steps.push({ direction, relationshipTypes: [], ...carried });
      else if (!arrivalTypes(profile, from, direction).includes(arrival)) steps.push({ direction, relationshipTypes: [], ...carried });
      else {
        const allowed = relationshipChoices(profile, from, arrival, direction);
        steps.push({ direction, arrivesAt: arrival, relationshipTypes: step.relationshipTypes.filter((type) => allowed.includes(type)), ...carried });
      }
      continue;
    }
    if (!stepStillJoins(profile, from, step)) break;
    steps.push(step);
  }
  return { draft: { ...draft, steps }, removed: draft.steps.length - steps.length };
}

export type Action =
  | { readonly type: 'start'; readonly anchorType: string | undefined }
  | { readonly type: 'add' }
  | { readonly type: 'direction'; readonly index: number; readonly direction: Direction | undefined }
  | { readonly type: 'arrives'; readonly index: number; readonly arrivesAt: string | undefined }
  | { readonly type: 'toggle'; readonly index: number; readonly relationshipType: string }
  | { readonly type: 'remove' }
  | { readonly type: 'add-condition'; readonly index: number; readonly mask: boolean }
  | { readonly type: 'change-condition'; readonly index: number; readonly id: number; readonly change: Partial<ConditionRow> }
  | { readonly type: 'remove-condition'; readonly index: number; readonly id: number }
  | { readonly type: 'window'; readonly index: number; readonly window: WindowDraft };

export interface BuilderState {
  readonly draft: Draft;
  /** The steps the last change removed; shown once, and cleared by the next change. */
  readonly removed: number;
  /** Set when the last change took windows off steps that no longer have a dated relationship type; shown once, cleared by the next change. */
  readonly windowDropped?: boolean;
}

export const INITIAL: BuilderState = { draft: EMPTY_DRAFT, removed: 0 };

/** Applies a change to the draft; the profile is the bound source's, which decides what still joins. */
export function reduce(profile: SourceProfile, state: BuilderState, action: Action): BuilderState {
  const { draft } = state;
  switch (action.type) {
    case 'start': {
      const repaired = repair(profile, { ...draft, anchorType: action.anchorType }, 0);
      return settled(profile, repaired);
    }
    case 'add':
      return { draft: { ...draft, steps: [...draft.steps, { relationshipTypes: [] }] }, removed: 0 };
    case 'remove':
      return { draft: { ...draft, steps: draft.steps.slice(0, -1) }, removed: 0 };
    case 'direction':
    case 'arrives':
    case 'toggle': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      let next: StepDraft = step;
      if (action.type === 'direction') next = { ...step, direction: action.direction };
      else if (action.type === 'arrives') next = { ...step, arrivesAt: action.arrivesAt, relationshipTypes: [] };
      else {
        const checked = step.relationshipTypes.includes(action.relationshipType);
        if (!checked && step.relationshipTypes.length >= PATTERN_LIMITS.relationshipTypesPerStep) return state;
        next = { ...step, relationshipTypes: checked ? step.relationshipTypes.filter((type) => type !== action.relationshipType) : [...step.relationshipTypes, action.relationshipType] };
      }
      const steps = draft.steps.map((candidate, index) => (index === action.index ? next : candidate));
      const repaired = repair(profile, { ...draft, steps }, action.index);
      return settled(profile, repaired);
    }
    case 'add-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      const offered = offeredProperties(profile, previousTypeOf(draft, action.index), step, action.mask);
      const choice = addConditionBlock(offered, step, draft.steps) === undefined ? firstChoice(offered, step) : undefined;
      if (choice === undefined) return state;
      const row: ConditionRow = { id: nextRowId(draft.steps), on: choice.on, property: choice.property, op: 'eq', text: '', from: '', to: '', kind: 'auto' };
      return { draft: withStep(draft, action.index, { ...step, conditions: [...rowsOf(step), row] }), removed: 0 };
    }
    case 'change-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      const rows = rowsOf(step).map((row) => (row.id === action.id ? { ...row, ...action.change, touched: true } : row));
      return { draft: withStep(draft, action.index, { ...step, conditions: rows }), removed: 0 };
    }
    case 'remove-condition': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      return { draft: withStep(draft, action.index, { ...step, conditions: rowsOf(step).filter((row) => row.id !== action.id) }), removed: 0 };
    }
    case 'window': {
      const step = draft.steps[action.index];
      if (step === undefined) return state;
      return { draft: withStep(draft, action.index, { ...step, window: action.window }), removed: 0 };
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

const withStep = (draft: Draft, index: number, step: StepDraft): Draft => ({ ...draft, steps: draft.steps.map((candidate, at) => (at === index ? step : candidate)) });

/** After a repair: a window on a step none of whose carrying rows is dated is taken off, and the person is told once. */
function settled(profile: SourceProfile, repaired: Repaired): BuilderState {
  let dropped = false;
  const steps = repaired.draft.steps.map((step, index) => {
    if (windowOf(step).kind === 'none' || windowReach(profile, previousTypeOf(repaired.draft, index), step).appliesTo.length > 0) return step;
    if (carryingRows(profile, previousTypeOf(repaired.draft, index), step).length === 0 && !isComplete(step)) return step;
    dropped = true;
    return { ...step, window: NO_WINDOW };
  });
  return { draft: { ...repaired.draft, steps }, removed: repaired.removed, ...(dropped ? { windowDropped: true } : {}) };
}

/**
 * The definition the server is asked about: only when the start type and every step are complete, every condition row is read and still offered for its step, and the window is read. A definition held back is never shown as valid or invalid.
 */
export function toDefinition(draft: Draft, profile: SourceProfile, mask: boolean): PatternDefinition | undefined {
  if (draft.anchorType === undefined || draft.steps.length === 0) return undefined;
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
