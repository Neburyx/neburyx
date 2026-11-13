import { PATTERN_LIMITS, windowSchema, type ExpandFilter, type SourceProfile, type Window } from '@neburyx/contracts';
import { readDays } from '../../api/expand-window.js';
import { declaredProperties, readDraft, type Declared, type FilterDraft } from '../../workspace/expand-refine.js';
import type { Direction, StepDraft } from './model.js';

/** A condition as the person has typed it: Expand's row, and whether the person has edited it yet (an empty new row says nothing until then). */
export type ConditionRow = FilterDraft & { readonly touched?: boolean };

/** The window of a step as chosen: none, a number of days, or two dates, each typed. */
export type WindowDraft = { readonly kind: 'none' } | { readonly kind: 'days'; readonly text: string } | { readonly kind: 'dates'; readonly from: string; readonly to: string };

export const NO_WINDOW: WindowDraft = { kind: 'none' };

export const windowOf = (step: StepDraft): WindowDraft => step.window ?? NO_WINDOW;
export const rowsOf = (step: StepDraft): readonly ConditionRow[] => step.conditions ?? [];

type MappingRow = SourceProfile['relationshipTypes'][number];

/** The mapping rows of the step's chosen relationship types that carry it from the previous node type in its direction: the rows the server reads, so that what is offered is what is accepted. */
export function carryingRows(profile: SourceProfile, from: string | undefined, step: StepDraft): readonly MappingRow[] {
  const { direction, arrivesAt } = step;
  if (from === undefined || direction === undefined || arrivesAt === undefined) return [];
  const carries = (row: MappingRow, way: Direction): boolean => (way === 'out' ? row.from === from && row.to === arrivesAt : way === 'in' ? row.from === arrivesAt && row.to === from : (row.from === from && row.to === arrivesAt) || (row.from === arrivesAt && row.to === from));
  return profile.relationshipTypes.filter((row) => step.relationshipTypes.includes(row.type) && carries(row, direction));
}

/** The properties a condition of this step may be on: the node's, and the relationship's when every carrying row declares it (a row's observed time counts as declared). A personal-data property is left out while masking is on. */
export function offeredProperties(profile: SourceProfile, from: string | undefined, step: StepDraft, mask: boolean): Declared {
  if (step.arrivesAt === undefined) return { neighbor: [], relationship: [] };
  const neighbor = declaredProperties(profile, from ?? '', [step.arrivesAt], undefined, 'filterable', mask).neighbor;
  const lists = carryingRows(profile, from, step).map((row) => [...new Set([...row.filterable, ...(row.observedAt === null ? [] : [row.observedAt])])]);
  const relationship = (lists[0] ?? []).filter((property) => lists.every((list) => list.includes(property)));
  return { neighbor, relationship };
}

/** Whether masking took a property away that the node would offer otherwise. */
export function maskLeftOut(profile: SourceProfile, from: string | undefined, step: StepDraft, mask: boolean): boolean {
  return mask && step.arrivesAt !== undefined && offeredProperties(profile, from, step, false).neighbor.length > offeredProperties(profile, from, step, true).neighbor.length;
}

export const isOffered = (row: ConditionRow, offered: Declared): boolean => (row.on === 'neighbor' ? offered.neighbor : offered.relationship).includes(row.property);

export const countOn = (rows: readonly ConditionRow[], on: ConditionRow['on']): number => rows.filter((row) => row.on === on).length;

export const nextRowId = (steps: readonly StepDraft[]): number => steps.reduce((most, step) => Math.max(most, ...rowsOf(step).map((row) => row.id)), 0) + 1;

export const totalConditions = (steps: readonly StepDraft[]): number => steps.reduce((sum, step) => sum + rowsOf(step).length, 0);

export type AddConditionBlock = { readonly kind: 'arrival' } | { readonly kind: 'none-offered' } | { readonly kind: 'pattern-cap' } | { readonly kind: 'side-cap'; readonly on: ConditionRow['on'] };

/** Why Add condition is disabled for a step, or nothing when a row can be added; the side the next row would be on is the first one that offers a property and has room. */
export function addConditionBlock(offered: Declared, step: StepDraft, steps: readonly StepDraft[]): AddConditionBlock | undefined {
  if (step.arrivesAt === undefined) return { kind: 'arrival' };
  const sides = (['neighbor', 'relationship'] as const).filter((on) => offered[on].length > 0);
  if (sides.length === 0) return { kind: 'none-offered' };
  if (totalConditions(steps) >= PATTERN_LIMITS.conditionsPerPattern) return { kind: 'pattern-cap' };
  const open = sides.find((on) => countOn(rowsOf(step), on) < PATTERN_LIMITS.conditionsPerElement);
  return open === undefined ? { kind: 'side-cap', on: sides[0] ?? 'neighbor' } : undefined;
}

/** The side and property a new row starts on: the first offered property of a side that has room. */
export function firstChoice(offered: Declared, step: StepDraft): { readonly on: ConditionRow['on']; readonly property: string } | undefined {
  for (const on of ['neighbor', 'relationship'] as const) {
    const property = offered[on][0];
    if (property !== undefined && countOn(rowsOf(step), on) < PATTERN_LIMITS.conditionsPerElement) return { on, property };
  }
  return undefined;
}

export interface ReadRows {
  readonly filters: readonly ExpandFilter[];
  readonly problems: ReadonlyMap<number, string>;
}

/** Every row, in order: a step may hold six conditions on its node and six on its relationship, which is more than Expand's list reads, so no row is left out and each one is whole or holds the definition back. */
export function readRows(rows: readonly ConditionRow[]): ReadRows {
  const filters: ExpandFilter[] = [];
  const problems = new Map<number, string>();
  for (const row of rows) {
    const read = readDraft(row);
    if (read.ok) filters.push(read.filter);
    else problems.set(row.id, read.reason);
  }
  return { filters, problems };
}

const WINDOW_DATES_SENTENCE = 'Enter two calendar dates like 2026-03-01, the start not after the end, at most 3650 days apart.';

export type WindowRead = { readonly ok: true; readonly window: Window | undefined } | { readonly ok: false; readonly reason: string };

/** The window a draft stands for (none for no window), or the one thing wrong with it. */
export function readWindow(draft: WindowDraft): WindowRead {
  if (draft.kind === 'none') return { ok: true, window: undefined };
  if (draft.kind === 'days') {
    const days = readDays(draft.text);
    return days.ok ? { ok: true, window: { days: days.days } } : days;
  }
  const parsed = windowSchema.safeParse({ from: draft.from.trim(), to: draft.to.trim() });
  return parsed.success ? { ok: true, window: parsed.data } : { ok: false, reason: WINDOW_DATES_SENTENCE };
}

export interface WindowReach {
  /** Chosen relationship types with a dated carrying row: the window filters them. */
  readonly appliesTo: readonly string[];
  /** Chosen relationship types with an undated carrying row: they are read whole. A type with both is in both lists. */
  readonly notAppliedTo: readonly string[];
}

export function windowReach(profile: SourceProfile, from: string | undefined, step: StepDraft): WindowReach {
  const rows = carryingRows(profile, from, step);
  const typesWhere = (dated: boolean): string[] => step.relationshipTypes.filter((type) => rows.some((row) => row.type === type && (row.observedAt !== null) === dated));
  return { appliesTo: typesWhere(true), notAppliedTo: typesWhere(false) };
}
