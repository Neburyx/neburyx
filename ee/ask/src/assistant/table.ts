import type { AssembledText } from '../case-summary/assemble.js';
import { descriptionHoldsVerdict, type CheckedText, type CheckRunner, type HeavyCheck, type JudgeInput, type Judged, type RejectedSentence } from '@neburyx/ee-ai-runtime';
import { pluralOf, tableRowsPhrase, ASSISTANT_TABLE_CELL_MAX, ASSISTANT_TABLE_CITES_MAX, ASSISTANT_TABLE_COLUMNS_MAX, ASSISTANT_TABLE_LABEL_MAX, type SummarySentence, type TypeDescriptions } from '@neburyx/contracts';

/** The most rows a reply may hold: a sanity bound of the reply, not the limit of the answer (the answer shows at most 25 rows and counts the rest). */
const TABLE_REPLY_ROWS_MAX = 100;

export interface TableRow {
  readonly cells: readonly string[];
  readonly cites: readonly string[];
}

export interface TableDraft {
  readonly columns: readonly string[];
  readonly rows: readonly TableRow[];
  /** The rows the reply wrote with no cite: they are dropped and counted, and no other row is lost for them. */
  readonly uncited: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number, empty: boolean): value is string => typeof value === 'string' && (empty || value.trim() !== '') && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

/** The table of a reply of the exact shape `{"columns":[...],"rows":[{"cells":[...],"cites":[...]}]}`; any bound broken, any other member, a cell count that differs from the columns, is undefined. A row with an empty `cites` is dropped and counted in `uncited`. */
export function parseTable(value: unknown): TableDraft | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'columns,rows') return undefined;
  const { columns, rows } = value;
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > ASSISTANT_TABLE_COLUMNS_MAX || !columns.every((label): label is string => isText(label, ASSISTANT_TABLE_LABEL_MAX, false))) return undefined;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > TABLE_REPLY_ROWS_MAX) return undefined;
  const kept: TableRow[] = [];
  let uncited = 0;
  for (const row of rows as unknown[]) {
    if (!isRecord(row) || Object.keys(row).sort().join() !== 'cells,cites') return undefined;
    const { cells, cites } = row;
    if (!Array.isArray(cells) || cells.length !== columns.length || !cells.every((cell): cell is string => isText(cell, ASSISTANT_TABLE_CELL_MAX, true))) return undefined;
    if (!Array.isArray(cites) || cites.length > ASSISTANT_TABLE_CITES_MAX || !cites.every((cite): cite is string => typeof cite === 'string' && cite !== '')) return undefined;
    if (cites.length === 0) uncited += 1;
    else kept.push({ cells, cites });
  }
  return { columns, rows: kept, uncited };
}

/** A row read as one sentence for the checks: its cells joined, cited by the keys of the row. The column labels are judged apart (a label is no name of an element), so they are not in the text the name and number checks read. */
export const rowSentenceOf = (row: TableRow): SummarySentence => ({ text: row.cells.filter((cell) => cell.trim() !== '').join('; '), cites: [...row.cites] });

/** The plural words of what a table is about: the plain-words label of an entity type (or its name when the mapping gives none), and `Elements` for rows about several types or about a relationship type, which has no plain-words label. */
export function subjectPluralOf(subject: { readonly type: string; readonly text: string } | undefined, descriptions: TypeDescriptions | undefined): string {
  if (subject === undefined || !subject.text.startsWith('entity ')) return 'Elements';
  return pluralOf(descriptions?.entityTypes.find((entry) => entry.type === subject.type)?.displayName ?? subject.type);
}

export const rowsPhrase = tableRowsPhrase;

/**
 * The rows with the two ends of each relationship they cite added after the model's own cites, so that a cell that names an end is judged against that end's line and the person sees it cited. Only an end that has a line of its
 * own among the lines sent in this turn is added, never past the most a row may cite, and nothing is read. `added` says, by the row as it now stands, how many cites the server added to it.
 */
export function withEndsCited<Row extends { readonly cites: readonly string[] }>(rows: readonly Row[], assembled: Pick<AssembledText, 'keys' | 'relationshipEnds'>): { readonly rows: readonly Row[]; readonly added: ReadonlyMap<Row, number> } {
  const keyOfEntity = new Map([...assembled.keys].flatMap(([key, held]) => (held.kind === 'entity' ? [[JSON.stringify([held.ref.entityType, held.ref.stableId]), key] as const] : [])));
  const added = new Map<Row, number>();
  const out = rows.map((row) => {
    const ends = row.cites.flatMap((key) => (assembled.relationshipEnds?.get(key) ?? []).flatMap(([type, id]) => keyOfEntity.get(JSON.stringify([type, id])) ?? []));
    const missing = [...new Set(ends)].filter((key) => !row.cites.includes(key)).slice(0, Math.max(0, ASSISTANT_TABLE_CITES_MAX - row.cites.length));
    if (missing.length === 0) return row;
    const wider = { ...row, cites: [...row.cites, ...missing] };
    added.set(wider, missing.length);
    return wider;
  });
  return { rows: out, added };
}

/** The kinds of thing a line can be, in the words the model is offered for a column label. */
const LABEL_KINDS = ['element', 'entity', 'relationship'] as const;
/**
 * The words a column label may use besides the properties and the types of the text sent: a fixed list of the code (a label names what a column holds, never a count or a free column). The one definition of those words:
 * the check accepts them and the `answer` tool offers them from here.
 */
export const OFFERED_LABEL_WORDS: readonly string[] = [...LABEL_KINDS, 'type', 'title', 'name', 'id', 'date', 'time', 'status', 'direction', 'description', 'currency', 'cite'];
const PLURAL_KINDS = ['elements', 'entities', 'relationships'] as const;
const FIXED_LABEL_WORDS: ReadonlySet<string> = new Set([...OFFERED_LABEL_WORDS, ...PLURAL_KINDS]);

const wordsOfKey = (token: string): string[] => token.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z]+/u).filter((word) => word.length > 1);

/** The words of the keys of the properties and of the types in the text sent: `amountUsd: 4200` gives amount and usd, `"transaction"` and `r1: transaction:` give transaction. */
export function labelWordsOf(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const found of text.matchAll(/(?:^|[|;]\s*|\n)([A-Za-z_][A-Za-z0-9_.-]*): /gu)) for (const word of wordsOfKey(found[1] ?? '')) words.add(word);
  for (const found of text.matchAll(/\| "([^"]+)"|^[a-z]\d+: ([A-Za-z_][A-Za-z0-9_-]*): /gmu)) for (const word of wordsOfKey(found[1] ?? found[2] ?? '')) words.add(word);
  return words;
}

/** Whether every column label of a table is plain words that the text sent or the fixed list holds: letters, spaces and hyphens only, no verdict word, each word a word of a property key or a type of the text sent (or its plural) or one of the fixed words. */
export function labelsHold(columns: readonly string[], text: string): boolean {
  const known = labelWordsOf(text);
  return columns.every((label) => {
    if (!/^[\p{L}][\p{L} /-]*$/u.test(label) || descriptionHoldsVerdict(label, [])) return false;
    return (label.toLowerCase().match(/\p{L}+/gu) ?? []).every((word) => FIXED_LABEL_WORDS.has(word) || known.has(word) || known.has(word.replace(/s$/u, '')) || known.has(`${word}s`));
  });
}

/** What the checks made of the rows of a table reply: the rows kept, as sentences and by their position in the reply. */
export type JudgedRows =
  | { readonly refused: 'worker-failed' | 'timeout' | 'cancelled' }
  | { readonly kept: Judged['kept'][number][]; readonly removed: number; readonly rejected: readonly RejectedSentence[]; readonly verdictFound: boolean; readonly keysStripped: number; readonly keysRemoved: number; readonly positions: readonly number[] };

/**
 * Judges the rows of a table reply, each alone, so that the rows kept are known by their position (in place and in a worker thread alike): a row that `drop` names is removed unjudged, a row whose text a check changed (a key written in a cell) is removed
 * so that every row kept shows its cells exactly as judged, and a column label no word backs fails the whole reply (nothing is kept, and the model is asked again while a call remains).
 */
export async function judgeTableRows(input: {
  readonly rows: readonly SummarySentence[];
  readonly columns: readonly string[] | undefined;
  readonly checks: CheckRunner;
  readonly judge: HeavyCheck<JudgeInput, Judged>;
  readonly text: CheckedText;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly drop: (row: SummarySentence) => boolean;
}): Promise<JudgedRows> {
  const none: JudgedRows = { kept: [], removed: input.rows.length, rejected: input.rows.map((row) => ({ text: row.text, reason: 'label' as const })), verdictFound: false, keysStripped: 0, keysRemoved: 0, positions: [] };
  if (input.columns !== undefined && !labelsHold(input.columns, input.text.text)) return none;
  const runs = await Promise.all(input.rows.map((row) => (input.drop(row) ? undefined : input.checks.run(input.judge, { sentences: [row], text: input.text, tableRows: true }, { timeoutMs: input.timeoutMs, signal: input.signal }))));
  const kept: Judged['kept'][number][] = [];
  const positions: number[] = [];
  const rejected: RejectedSentence[] = [];
  let removed = 0;
  let verdictFound = false;
  let keysStripped = 0;
  let keysRemoved = 0;
  for (const [index, run] of runs.entries()) {
    const row = input.rows[index];
    if (row === undefined) continue;
    if (run === undefined) {
      removed += 1;
      rejected.push({ text: row.text, reason: 'row' });
      continue;
    }
    if (run.status === 'refused') return { refused: run.reason };
    verdictFound ||= run.value.verdictFound;
    keysStripped += run.value.keysStripped;
    keysRemoved += run.value.keysRemoved;
    const [held] = run.value.kept;
    if (held !== undefined && held.text === row.text && held.cites.join() === row.cites.join()) {
      kept.push(row);
      positions.push(index);
    } else {
      removed += 1;
      const [reason] = run.value.rejected;
      rejected.push(reason === undefined ? { text: row.text, reason: 'key' } : { text: reason.text, reason: reason.reason === 'number' ? 'cell' : reason.reason });
    }
  }
  return { kept, removed, rejected, verdictFound, keysStripped, keysRemoved, positions };
}

/** What the turn tells the model when the router chose the table form. */
export const TABLE_NOTE = '\n\nThe analyst asked for the answer as a table.';

/** The type of an element key of the text sent: an entity type or a relationship type, with the text that says which kind it is. */
export function typeOfKey(assembled: AssembledText, key: string): { readonly type: string; readonly text: string } | undefined {
  const held = assembled.keys.get(key);
  if (held === undefined) return undefined;
  if (held.kind === 'entity') return { type: held.ref.entityType, text: `entity ${held.ref.entityType}` };
  const type = 'aggregate' in held.ref ? held.ref.aggregate.type : 'derived' in held.ref ? held.ref.derived.ruleId : held.ref.type;
  return { type, text: `relationship ${type}` };
}

/** The type every row of a table is about, by the first element each row cites; none when the rows are about more than one. */
export function subjectTypeOf(rows: readonly { readonly cites: readonly string[] }[], assembled: AssembledText): { readonly type: string; readonly text: string } | undefined {
  const types = new Map(rows.flatMap((row) => {
    const found = row.cites[0] === undefined ? undefined : typeOfKey(assembled, row.cites[0]);
    return found === undefined ? [] : [[found.text, found] as const];
  }));
  return types.size === 1 ? [...types.values()][0] : undefined;
}

/**
 * What a table's title and note were written from, for the table block: the entity type its rows are about (none when they are about several types or about relationships), the title of the element a read listed them from, and the properties whose unit the note gives. A stored answer keeps these, not the words, and says the words again from the current mapping.
 */
export function tableFactsOf(subject: { readonly type: string; readonly text: string } | undefined, units: readonly { readonly type: string; readonly property: string }[], anchor?: string): { subject?: string; anchor?: string; units?: { type: string; property: string }[] } {
  return {
    ...(subject === undefined || !subject.text.startsWith('entity ') ? {} : { subject: subject.type }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(units.length === 0 ? {} : { units: units.map(({ type, property }) => ({ type, property })) }),
  };
}

/**
 * How many elements the rows of a table come from, when that can be said exactly: each row (the rows shown and the rows cut) stands on the first element it cites, no two rows on the same one, and every one of them is among `held`, the elements of the
 * set that is counted (the elements of the type that a read listed, or that the reads or the view returned). Then the count of that set is a true count of what the rows were drawn from and is at least the rows shown and cut. Otherwise nothing: a count of
 * a set the rows may not come from, or of fewer elements than there are rows, is a number the server has no ground for.
 */
export function exactSetCount(rows: readonly { readonly cites: readonly string[] }[], held: readonly string[]): number | undefined {
  const firsts = rows.map((row) => row.cites[0]);
  const distinct = new Set<string>();
  for (const key of firsts) {
    if (key === undefined || distinct.has(key)) return undefined;
    distinct.add(key);
  }
  const members = new Set(held);
  return distinct.size === rows.length && [...distinct].every((key) => members.has(key)) ? members.size : undefined;
}
