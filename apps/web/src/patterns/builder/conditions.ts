import { PATTERN_LIMITS, WINDOW_MAX_DAYS, type ExpandFilter, type FilterKind, type SourceProfile, type Window } from '@neburyx/contracts';
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

/** The kind a property is declared to hold, or `unknown`; a hint for the screen, never read by a statement. */
export type PropertyKind = FilterKind | 'unknown';

/**
 * The kind the mapping declares for a property of a step: for the arriving node, its type's; for the relationship, the one every carrying row that declares one agrees on (`unknown` when they differ).
 * Nothing when the source's answer carries no kinds at all (an older server), so that the screen shows names only.
 */
export function propertyKind(profile: SourceProfile, from: string | undefined, step: StepDraft, on: ConditionRow['on'], property: string): PropertyKind | undefined {
  if (on === 'neighbor') return profile.entityTypes.find((entity) => entity.type === step.arrivesAt)?.filterKinds?.[property];
  const declared = carryingRows(profile, from, step).flatMap((row) => (row.filterKinds === undefined ? [] : [row.filterKinds[property] ?? 'unknown']));
  if (declared.length === 0) return undefined;
  return declared.every((kind) => kind === declared[0]) ? declared[0] : 'unknown';
}

/** How many personal-data properties of the arriving type the mapping lets a condition use and masking hides. */
export function hiddenPersonalCount(profile: SourceProfile, step: StepDraft, mask: boolean): number {
  const entity = profile.entityTypes.find((candidate) => candidate.type === step.arrivesAt);
  return !mask || entity === undefined ? 0 : entity.filterable.filter((property) => entity.pii.includes(property)).length;
}

/** The kind a row reads its values as: the declared one, or `auto` (the kind is detected from the text) when it is unknown or not declared. */
export const rowKindFor = (kind: PropertyKind | undefined): ConditionRow['kind'] => (kind === undefined || kind === 'unknown' ? 'auto' : kind);

/** The operators a kind has: a range does not apply to true or false. */
export const operatorsFor = (kind: PropertyKind | undefined): readonly ConditionRow['op'][] => (kind === 'boolean' ? ['eq', 'in'] : ['eq', 'in', 'between']);

/** The condition of a row in a line: the property, the operator in words and the values as typed. */
export function conditionSummary(row: ConditionRow): string {
  if (row.op === 'eq') return row.text.trim() === '' ? `${row.property} has no value yet` : `${row.property} is ${row.text.trim()}`;
  if (row.op === 'in') {
    const values = row.text.split(',').map((part) => part.trim()).filter((part) => part !== '');
    return values.length === 0 ? `${row.property} has no values yet` : `${row.property} is one of ${values.join(', ')}`;
  }
  const from = row.from.trim();
  const to = row.to.trim();
  if (from !== '' && to !== '') return `${row.property} is between ${from} and ${to}`;
  if (from !== '') return `${row.property} is ${from} or more`;
  if (to !== '') return `${row.property} is ${to} or less`;
  return `${row.property} has no range yet`;
}

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

export const WINDOW_SENTENCES = {
  days: `Enter a whole number of days from 1 to ${WINDOW_MAX_DAYS}.`,
  date: 'Enter a calendar date like 2026-03-01.',
  order: 'Before the start date',
  range: `At most ${WINDOW_MAX_DAYS.toLocaleString('en-US')} days, both dates included.`,
} as const;

/** What a window can be wrong in, and at which of its fields: the days, a date, the order of the two or their distance. */
export type WindowRead = { readonly ok: true; readonly window: Window | undefined } | { readonly ok: false; readonly reason: string; readonly at: 'days' | 'from' | 'to' | 'range' };

const DAY_MS = 86_400_000;
const calendarDay = (text: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || !new Date(time).toISOString().startsWith(text) ? undefined : time;
};

/** The window a draft stands for (none for no window), or the one thing wrong with it and the field it is at. */
export function readWindow(draft: WindowDraft): WindowRead {
  if (draft.kind === 'none') return { ok: true, window: undefined };
  if (draft.kind === 'days') {
    const days = readDays(draft.text);
    return days.ok ? { ok: true, window: { days: days.days } } : { ok: false, reason: days.reason, at: 'days' };
  }
  const from = draft.from.trim();
  const to = draft.to.trim();
  const start = calendarDay(from);
  const end = calendarDay(to);
  if (start === undefined) return { ok: false, reason: WINDOW_SENTENCES.date, at: 'from' };
  if (end === undefined) return { ok: false, reason: WINDOW_SENTENCES.date, at: 'to' };
  if (end < start) return { ok: false, reason: WINDOW_SENTENCES.order, at: 'to' };
  if ((end - start) / DAY_MS >= WINDOW_MAX_DAYS) return { ok: false, reason: WINDOW_SENTENCES.range, at: 'range' };
  return { ok: true, window: { from, to } };
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

export interface WindowTypeLine {
  readonly type: string;
  /** The observed-time properties of the carrying rows that have one: the window filters the type on these. */
  readonly datedOn: readonly string[];
  /** Whether a carrying row of the type has no observed time: the window does not apply to it. */
  readonly undated: boolean;
}

/** For each chosen relationship type, what the window can filter it on and whether any of its carrying rows has no date. */
export function windowTypeLines(profile: SourceProfile, from: string | undefined, step: StepDraft): readonly WindowTypeLine[] {
  const rows = carryingRows(profile, from, step);
  return step.relationshipTypes.map((type) => {
    const mine = rows.filter((row) => row.type === type);
    return { type, datedOn: [...new Set(mine.flatMap((row) => (row.observedAt === null ? [] : [row.observedAt])))], undated: mine.some((row) => row.observedAt === null) };
  });
}
