import type { GraphProperty } from '@neburyx/contracts';
import { propertyText } from '../inspector/property-text.js';
import { EMPTY, NOT_MAPPED, NOT_STATED, UNAVAILABLE, VARIES_BY_MEMBER } from './copy.js';

export type CellKind = 'value' | 'empty' | 'unavailable' | 'masked' | 'not-mapped' | 'not-stated' | 'varies';

export interface Cell {
  readonly kind: CellKind;
  readonly text: string;
  /** What two compared cells are equal by; set for a value, an empty text and an unavailable value only. */
  readonly same?: string;
  /** Cells of different families are never compared with each other (an aggregate's range of times and a single time); none means the ordinary family. */
  readonly family?: string;
}

export type RowStatus = 'differs' | 'same' | 'cannot';

export interface Row {
  readonly id: string;
  readonly label: string;
  readonly cells: readonly Cell[];
  readonly status: RowStatus;
  readonly includesMasked: boolean;
}

export type ElementKind = 'entity' | 'stored' | 'aggregate' | 'derived' | 'unknown';

/** A row the element brings besides its mapped properties (a relationship's observed time, its rule, its member count). */
export interface Extra {
  readonly id: string;
  readonly label: string;
  readonly cell: Cell;
}

export interface CompareElement {
  readonly key: string;
  readonly kind: ElementKind;
  /** The mapped property keys of its type, from the source profile; none when the profile does not hold the type. */
  readonly mapped: readonly string[] | undefined;
  readonly properties: readonly GraphProperty[];
  readonly extras: readonly Extra[];
}

const ZONE_NAME = /\[[^\]]*\]$/;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(Reflect.get(value, key))}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** What two values are equal by: the same data class and the same value, an instant by its time, a number by its number, anything else by its canonical JSON. */
function sameKey(property: GraphProperty): string {
  const { value, dataClass } = property;
  if (dataClass === 'dateTime' && typeof value === 'string') {
    const instant = Date.parse(value.replace(ZONE_NAME, ''));
    if (!Number.isNaN(instant)) return `v|dateTime|${instant}`;
  }
  if (typeof value === 'number') return `v|${dataClass}|${String(value)}`;
  return `v|${dataClass}|${stable(value)}`;
}

const UNAVAILABLE_CELL: Cell = { kind: 'unavailable', text: UNAVAILABLE, same: 'u' };

export function propertyCell(property: GraphProperty | undefined): Cell {
  if (property === undefined) return UNAVAILABLE_CELL;
  if (property.masked) return { kind: 'masked', text: propertyText(property) };
  if (property.value === undefined || property.value === null) return UNAVAILABLE_CELL;
  if (property.value === '') return { kind: 'empty', text: EMPTY, same: 'e' };
  return { kind: 'value', text: propertyText(property), same: sameKey(property) };
}

const NOT_MAPPED_CELL: Cell = { kind: 'not-mapped', text: NOT_MAPPED };
const NOT_STATED_CELL: Cell = { kind: 'not-stated', text: NOT_STATED };
const VARIES_CELL: Cell = { kind: 'varies', text: VARIES_BY_MEMBER };

export const notStated = (): Cell => NOT_STATED_CELL;

function cellFor(element: CompareElement, key: string): Cell {
  if (element.kind === 'derived') return NOT_MAPPED_CELL;
  if (element.kind === 'aggregate') return VARIES_CELL;
  if (element.mapped !== undefined && !element.mapped.includes(key)) return NOT_MAPPED_CELL;
  return propertyCell(element.properties.find((property) => property.key === key));
}

const COMPARED: ReadonlySet<CellKind> = new Set(['value', 'empty', 'unavailable']);

/**
 * *Differs* when two compared cells of one family do not match; *Same* when some family has at least two compared cells, all match and none is masked; otherwise *Cannot compare*: a masked value could differ, so it never makes a match,
 * and a cell is compared only with cells of its own family.
 */
export function statusOf(cells: readonly Cell[]): RowStatus {
  const families = new Map<string, Cell[]>();
  for (const cell of cells.filter((own) => COMPARED.has(own.kind))) families.set(cell.family ?? '', [...(families.get(cell.family ?? '') ?? []), cell]);
  const groups = [...families.values()];
  if (groups.some((group) => new Set(group.map((cell) => cell.same)).size > 1)) return 'differs';
  if (groups.some((group) => group.length >= 2) && !cells.some((cell) => cell.kind === 'masked')) return 'same';
  return 'cannot';
}

function rowOf(id: string, label: string, cells: readonly Cell[]): Row {
  return { id, label, cells, status: statusOf(cells), includesMasked: cells.some((cell) => cell.kind === 'masked') };
}

/** Every property key of the elements' types, the first element's first, then the extras (Observed, Rule, Members) the elements bring; one cell per element in each row. */
export function buildRows(elements: readonly CompareElement[]): readonly Row[] {
  const keys: string[] = [];
  for (const element of elements) {
    if (element.kind === 'derived') continue;
    for (const key of element.mapped ?? element.properties.map((property) => property.key)) if (!keys.includes(key)) keys.push(key);
  }
  const extras: Array<{ readonly id: string; readonly label: string }> = [];
  for (const element of elements) for (const extra of element.extras) if (!extras.some((known) => known.id === extra.id)) extras.push({ id: extra.id, label: extra.label });
  return [
    ...keys.map((key) => rowOf(`property:${key}`, key, elements.map((element) => cellFor(element, key)))),
    ...extras.map((extra) => rowOf(`extra:${extra.id}`, extra.label, elements.map((element) => element.extras.find((own) => own.id === extra.id)?.cell ?? (extra.id === 'observed' ? NOT_STATED_CELL : NOT_MAPPED_CELL)))),
  ];
}

/**
 * Whether "differences only" leaves the row out: a row that is *Same*, and a row with at most one compared cell (a value, empty or unavailable; the rest are not mapped, not stated or varies by member), which nothing can be said about.
 * A row with a masked cell is never left out, because a masked value could differ.
 */
export function isQuiet(row: Row): boolean {
  if (row.includesMasked) return false;
  return row.status === 'same' || row.cells.filter((cell) => COMPARED.has(cell.kind)).length <= 1;
}

/** True when no two columns map a property in common: every row is *Cannot compare* because fewer than two cells are compared (a masked table is not this case). */
export function shareNoProperty(rows: readonly Row[]): boolean {
  return rows.length > 0 && rows.every((row) => row.cells.filter((cell) => COMPARED.has(cell.kind) || cell.kind === 'masked').length < 2);
}
