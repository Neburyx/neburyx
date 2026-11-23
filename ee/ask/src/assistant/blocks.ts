import { ASSISTANT_BLOCKS_MAX, ASSISTANT_SENTENCES_MAX, ASSISTANT_TABLE_ROWS_MAX, type AssistantBlocks, type AssistantTable, type SummarySentence, type TypeDescriptions } from '@neburyx/contracts';
import { parseTable, rowsPhrase, type TableDraft } from './table.js';

/** The fixed sentence that ends the note of a table block. */
const TABLE_NOTE_SELECT = 'Each row selects its elements on the graph.';

type Cited = ReadonlyMap<string, { readonly ref: unknown }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const unquoted = (value: string): string => (value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
const numberOf = (value: string): number | undefined => {
  const plain = value.trim().replace(/,/gu, '');
  return plain !== '' && /^-?\d+(\.\d+)?$/u.test(plain) ? Number(plain) : undefined;
};

/** Whether a cell shows the value a line holds for a property: the same text, or the same number written with or without thousands separators. */
function showsValue(cell: string, value: string): boolean {
  const left = unquoted(cell.trim());
  const right = unquoted(value.trim());
  if (left === right) return true;
  const a = numberOf(left);
  return a !== undefined && a === numberOf(right);
}

/** The `name: value` pairs of the properties on the line of an element: after its key and type, the properties are separated by " | " and "; ". */
function propertiesOfLine(line: string): readonly (readonly [string, string])[] {
  return line
    .split(' | ')
    .slice(2)
    .flatMap((segment) => segment.split('; '))
    .flatMap((part) => {
      const colon = part.indexOf(': ');
      return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 2)] as const];
    });
}

/**
 * The note of a table block, written by the server: for each column, the first property the mapping gives a unit that a cell of the column shows the value of, on a cited element's line (the own-value rule), as "<label> in <unit>.", then the fixed sentence.
 * The words of a clause are the mapping's; none is fixed copy.
 */
export function noteOfTable(input: { readonly columns: readonly string[]; readonly rows: readonly { readonly cells: readonly string[]; readonly cites: readonly string[] }[]; readonly lines: ReadonlyMap<string, string>; readonly elements: Cited; readonly descriptions: TypeDescriptions | undefined }): string {
  const clauses: string[] = [];
  for (const [column] of input.columns.entries()) {
    const found = firstUnitOf(column, input);
    if (found !== undefined && !clauses.includes(found)) clauses.push(found);
  }
  return [...clauses, TABLE_NOTE_SELECT].join(' ');
}

function firstUnitOf(column: number, input: Parameters<typeof noteOfTable>[0]): string | undefined {
  for (const row of input.rows) {
    const cell = row.cells[column];
    if (cell === undefined || cell.trim() === '') continue;
    for (const key of row.cites) {
      const ref = input.elements.get(key)?.ref;
      const type = isRecord(ref) && typeof ref['entityType'] === 'string' ? ref['entityType'] : undefined;
      const display = type === undefined ? undefined : input.descriptions?.entityTypes.find((entry) => entry.type === type)?.propertyDisplay;
      const line = input.lines.get(key);
      if (display === undefined || line === undefined) continue;
      for (const [name, value] of propertiesOfLine(line)) {
        const shown = display[name];
        if (shown?.unit !== undefined && showsValue(cell, value)) return `${capitalised(shown.label ?? name)} in ${shown.unit}.`;
      }
    }
  }
  return undefined;
}

export type BlockInput =
  | { readonly kind: 'sentences'; readonly sentences: readonly SummarySentence[] }
  | { readonly kind: 'table'; readonly draft: TableDraft };

const SENTENCE_MEMBERS = 'cites,text';

/** The blocks of the `answer` tool's input: one to four of the kinds `sentences` and (when a table was asked for) `table`, each of the exact shape; anything else is undefined, and no part of it is shown. */
export function parseBlocksInput(value: unknown, tableAsked: boolean): readonly BlockInput[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > ASSISTANT_BLOCKS_MAX) return undefined;
  const blocks: BlockInput[] = [];
  for (const block of value as unknown[]) {
    if (!isRecord(block)) return undefined;
    if (block['kind'] === 'sentences') {
      if (Object.keys(block).sort().join() !== 'kind,sentences' || !Array.isArray(block['sentences']) || block['sentences'].length < 1) return undefined;
      const sentences: SummarySentence[] = [];
      for (const sentence of block['sentences'] as unknown[]) {
        if (!isRecord(sentence) || Object.keys(sentence).sort().join() !== SENTENCE_MEMBERS || typeof sentence['text'] !== 'string' || sentence['text'].trim() === '' || !Array.isArray(sentence['cites']) || !sentence['cites'].every((cite): cite is string => typeof cite === 'string')) return undefined;
        sentences.push({ text: sentence['text'], cites: sentence['cites'] });
      }
      blocks.push({ kind: 'sentences', sentences });
    } else if (block['kind'] === 'table' && tableAsked) {
      const draft = parseTable({ columns: block['columns'], rows: block['rows'] });
      if (draft === undefined || Object.keys(block).sort().join() !== 'columns,kind,rows') return undefined;
      blocks.push({ kind: 'table', draft });
    } else return undefined;
  }
  return blocks;
}

/** A block that was checked and kept: its content as the answer shows it. */
export type KeptBlock =
  | { readonly kind: 'sentences'; readonly sentences: readonly SummarySentence[] }
  | { readonly kind: 'table'; readonly table: AssistantTable; /** The coverage line of the table as the checks wrote it. */ readonly summary?: string };

/**
 * The blocks of one answer after the totals: kept rows beyond the 25th of all the tables are cut from the later tables and counted in the `moreNotShown` of the table they were cut from (a table left with no row is left out), and kept sentences beyond the 12th of all the sentences blocks are cut from the end. The order of the blocks is the model's.
 */
export function withinTotals(kept: readonly KeptBlock[]): { readonly blocks: AssistantBlocks; readonly leftOut: number; readonly summaries: readonly string[] } {
  let rowsLeft = ASSISTANT_TABLE_ROWS_MAX;
  let sentencesLeft = ASSISTANT_SENTENCES_MAX;
  let leftOut = 0;
  const blocks: AssistantBlocks = [];
  const summaries: string[] = [];
  for (const block of kept) {
    if (block.kind === 'sentences') {
      const shown = block.sentences.slice(0, sentencesLeft);
      sentencesLeft -= shown.length;
      if (shown.length === 0) leftOut += 1;
      else blocks.push({ kind: 'sentences', sentences: [...shown] });
      continue;
    }
    const rows = block.table.rows.slice(0, rowsLeft);
    rowsLeft -= rows.length;
    const cut = block.table.rows.length - rows.length;
    const moreNotShown = (block.table.moreNotShown ?? 0) + cut;
    if (rows.length === 0) {
      leftOut += 1;
      // its rows are counted as not shown with the last table that is shown
      const before = blocks.findLast((entry) => entry.kind === 'table');
      if (before?.kind === 'table') before.table = { ...before.table, moreNotShown: (before.table.moreNotShown ?? 0) + moreNotShown, ...(block.table.droppedRows === undefined ? {} : { droppedRows: (before.table.droppedRows ?? 0) + block.table.droppedRows }) };
      continue;
    }
    const { moreNotShown: _before, ...rest } = block.table;
    // the title and the coverage line state the rows that are shown
    const title = cut === 0 ? rest.title : rest.title.replace(/\d[\d,]* rows?$/u, rowsPhrase(rows.length));
    blocks.push({ kind: 'table', table: { ...rest, title, rows: [...rows], ...(moreNotShown > 0 ? { moreNotShown } : {}) } });
    summaries.push(block.summary === undefined ? '' : cut === 0 ? block.summary : block.summary.replace(/^\d[\d,]*/u, String(rows.length)));
  }
  return { blocks, leftOut, summaries };
}
