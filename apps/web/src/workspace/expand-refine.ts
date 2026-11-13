import { FILTER_KINDS, MAX_FILTER_TEXT, MAX_FILTERS, MAX_FILTER_VALUES, expandFilterSchema, type ExpandFilter, type ExpandRank, type FilterKind, type FilterValue, type SourceProfile } from '@neburyx/contracts';

/** What a person has put into one filter row: the property is named with the side it is on, and the values are text until they are read. */
export interface FilterDraft {
  readonly id: number;
  readonly on: 'neighbor' | 'relationship';
  readonly property: string;
  readonly op: 'eq' | 'in' | 'between';
  /** `eq`: the value; `in`: the values, separated by commas. */
  readonly text: string;
  readonly from: string;
  readonly to: string;
  /** `auto` reads the kind from what was typed. */
  readonly kind: 'auto' | FilterKind;
}

export const KIND_LABELS: Readonly<Record<'auto' | FilterKind, string>> = {
  auto: 'Detect',
  text: 'Text',
  number: 'Number',
  boolean: 'True or false',
  date: 'Date',
  dateTime: 'Date and time (with zone)',
  localDateTime: 'Date and time (no zone)',
  time: 'Time (with zone)',
  localTime: 'Time (no zone)',
};

export const emptyDraft = (id: number, on: FilterDraft['on'], property: string): FilterDraft => ({ id, on, property, op: 'eq', text: '', from: '', to: '', kind: 'auto' });

const ISO = (kind: FilterKind, text: string): boolean => expandFilterSchema.safeParse({ on: 'neighbor', property: 'p', op: 'eq', value: { kind, value: text } }).success;

/** The kind that typed text reads as: a number, true or false, an ISO date or time of one of the four temporal kinds, or else text. */
export function detectKind(text: string): FilterKind {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') return 'boolean';
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) return 'number';
  for (const kind of ['date', 'dateTime', 'localDateTime', 'time', 'localTime'] as const) if (ISO(kind, trimmed)) return kind;
  return 'text';
}

export type ValueRead = { readonly ok: true; readonly value: FilterValue } | { readonly ok: false; readonly reason: string };

/** One typed value read as the given kind (or the one it looks like), or why it cannot be. */
export function readValue(text: string, kind: 'auto' | FilterKind): ValueRead {
  const trimmed = kind === 'text' ? text : text.trim();
  if (trimmed === '' && kind !== 'text') return { ok: false, reason: 'Enter a value.' };
  const as = kind === 'auto' ? detectKind(text) : kind;
  if (as === 'number') {
    const number = Number(trimmed);
    if (!/^-?\d+(\.\d+)?$/.test(trimmed) || !Number.isFinite(number)) return { ok: false, reason: 'Enter a number.' };
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) return { ok: false, reason: 'That whole number is too large to be exact.' };
    return { ok: true, value: { kind: 'number', value: number } };
  }
  if (as === 'boolean') return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: { kind: 'boolean', value: trimmed === 'true' } } : { ok: false, reason: 'Enter true or false.' };
  if (as === 'text') return trimmed.length > MAX_FILTER_TEXT ? { ok: false, reason: `Enter at most ${MAX_FILTER_TEXT} characters.` } : { ok: true, value: { kind: 'text', value: trimmed } };
  return ISO(as, trimmed) ? { ok: true, value: { kind: as, value: trimmed } as FilterValue } : { ok: false, reason: `Enter ${as === 'date' ? 'a date like 2026-03-01' : as === 'time' || as === 'localTime' ? 'a time like 10:30:00' : 'a date and time like 2026-03-01T10:30:00'}${as === 'dateTime' || as === 'time' ? ' with a zone, such as Z or +01:00' : ''}.` };
}

export type DraftRead = { readonly ok: true; readonly filter: ExpandFilter } | { readonly ok: false; readonly reason: string };

/** The filter a row stands for, or the one thing wrong with it. */
export function readDraft(draft: FilterDraft): DraftRead {
  const target = { on: draft.on, property: draft.property };
  if (draft.op === 'eq') {
    const value = readValue(draft.text, draft.kind);
    return value.ok ? { ok: true, filter: { ...target, op: 'eq', value: value.value } } : value;
  }
  if (draft.op === 'in') {
    const parts = draft.text.split(',').map((part) => part.trim()).filter((part) => part !== '' || draft.kind === 'text');
    if (parts.length === 0) return { ok: false, reason: 'Enter at least one value, separated by commas.' };
    if (parts.length > MAX_FILTER_VALUES) return { ok: false, reason: `Enter at most ${MAX_FILTER_VALUES} values.` };
    const values: FilterValue[] = [];
    for (const part of parts) {
      const value = readValue(part, draft.kind);
      if (!value.ok) return value;
      values.push(value.value);
    }
    if (values.some((value) => value.kind !== values[0]?.kind)) return { ok: false, reason: 'The values must all be of one kind. Choose one in the kind list.' };
    return { ok: true, filter: { ...target, op: 'in', values } as ExpandFilter };
  }
  const from = draft.from.trim() === '' ? undefined : readValue(draft.from, draft.kind);
  const to = draft.to.trim() === '' ? undefined : readValue(draft.to, draft.kind);
  if (from !== undefined && !from.ok) return from;
  if (to !== undefined && !to.ok) return to;
  if (from === undefined && to === undefined) return { ok: false, reason: 'Enter a start, an end, or both.' };
  const ends = [from?.value, to?.value].filter((value): value is FilterValue => value !== undefined);
  if (ends.some((value) => value.kind !== ends[0]?.kind)) return { ok: false, reason: 'The start and the end must be of one kind. Choose one in the kind list.' };
  if (ends[0]?.kind === 'boolean') return { ok: false, reason: 'A range does not apply to true or false.' };
  return { ok: true, filter: { ...target, op: 'between', ...(from?.value === undefined ? {} : { from: from.value }), ...(to?.value === undefined ? {} : { to: to.value }) } as ExpandFilter };
}

/** The filters a list of rows asks for, or the first row that cannot be read. Rows with no value yet are not asked for: nothing is sent until each row is whole. */
export function readDrafts(drafts: readonly FilterDraft[]): { readonly filters: readonly ExpandFilter[]; readonly problems: ReadonlyMap<number, string> } {
  const filters: ExpandFilter[] = [];
  const problems = new Map<number, string>();
  for (const draft of drafts.slice(0, MAX_FILTERS)) {
    const read = readDraft(draft);
    if (read.ok) filters.push(read.filter);
    else problems.set(draft.id, read.reason);
  }
  return { filters, problems };
}

export const MAX_FILTER_ROWS = MAX_FILTERS;

export interface Declared {
  readonly neighbor: readonly string[];
  readonly relationship: readonly string[];
}

/**
 * The properties the panel may offer to filter or rank by, for what is asked now: a neighbor property when every ticked neighbor type declares it, and a relationship property when every mapping row the
 * asked relationship types and ticked neighbor types read declares it (a row's observed time counts as declared). A personal-data property is left out while masking is on. This is what the server
 * checks, so a property offered is a property accepted.
 */
export function declaredProperties(profile: SourceProfile | undefined, anchorType: string, neighborTypes: readonly string[], relationshipTypes: readonly string[] | undefined, use: 'filterable' | 'sortable', mask: boolean): Declared {
  if (profile === undefined || neighborTypes.length === 0) return { neighbor: [], relationship: [] };
  const entities = neighborTypes.map((type) => profile.entityTypes.find((entry) => entry.type === type));
  const lists = entities.map((entity) => (entity === undefined ? [] : entity[use].filter((property) => !(mask && entity.pii.includes(property)))));
  const neighbor = (lists[0] ?? []).filter((property) => lists.every((list) => list.includes(property)));
  const rows = profile.relationshipTypes.filter((row) => (relationshipTypes === undefined || relationshipTypes.includes(row.type)) && neighborTypes.some((type) => (row.from === anchorType && row.to === type) || (row.to === anchorType && row.from === type)));
  const declared = rows.map((row) => [...new Set([...row[use], ...(row.observedAt === null ? [] : [row.observedAt])])]);
  const relationship = (declared[0] ?? []).filter((property) => declared.every((list) => list.includes(property)));
  return { neighbor, relationship };
}

export const FILTER_KIND_CHOICES: readonly ('auto' | FilterKind)[] = ['auto', ...FILTER_KINDS];
