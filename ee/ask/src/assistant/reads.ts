import { isHeavyResult, type AskAnswer, type AskRunResult, type AssistantRead, type AssistantReadKind } from '@neburyx/contracts';
import { countOf } from './coverage.js';
import { summarizeRun } from '../questions/run-summary.js';

type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];

const SUBJECT_MAX_CHARACTERS = 400;
const PATTERN_PARAMETER = 'pattern';

/** The subject of a read: the values the gate accepted for the tool's parameters, as Ask's "Understood as" line shows them (a saved pattern's own name is the tool, not a value), or nothing when there are none. */
export function subjectOf(values: Readonly<Record<string, string>>): string | undefined {
  const text = Object.entries(values)
    .filter(([name]) => name !== PATTERN_PARAMETER)
    .map(([, value]) => value)
    .join(', ');
  return text === '' ? undefined : text.slice(0, SUBJECT_MAX_CHARACTERS);
}

/** A read that ran: its rows with the quality of that count (no number when the count is unknown), and whether the result says it was cut. */
export function readOfResult(kind: AssistantReadKind, tool: string, values: Readonly<Record<string, string>>, result: AskRunResult): AssistantRead {
  const { quality, value } = countOf(result);
  const subject = subjectOf(values);
  const known = quality !== 'unknown' && value !== undefined;
  return { tool, kind, ...(subject === undefined ? {} : { subject }), read: true, ...(known ? { rows: value } : {}), quality: known ? quality : 'unknown', partial: summarizeRun(result).partial };
}

export const readOfAnswer = (kind: AssistantReadKind, tool: string, answered: Answered): AssistantRead => readOfResult(kind, tool, answered.entities, answered.result);

/** A read that ran and found nothing: no rows, and the count is exact. */
export function readOfNothing(kind: AssistantReadKind, tool: string, values: Readonly<Record<string, string>>): AssistantRead {
  const subject = subjectOf(values);
  return { tool, kind, ...(subject === undefined ? {} : { subject }), read: true, rows: 0, quality: 'exact', partial: false };
}

/** A read that did not run: its values did not fit, or the view could not be read. */
export const readNotRead = (kind: AssistantReadKind, tool: string): AssistantRead => ({ tool, kind, read: false });

/** The view's reading, listed as a read of its own: the elements it gave, an exact count. */
export const readOfView = (rows: number): AssistantRead => ({ tool: 'view', kind: 'view', read: true, rows, quality: 'exact', partial: false });

/** The typology's lines, listed as a read of their own: lines of the product's own file, no rows of the source. */
export const readOfTypology = (lines: number): AssistantRead => ({ tool: 'typology', kind: 'typology', read: true, lines, quality: 'exact', partial: false });

/** The person's AI notes, listed as a read: the elements the gate gave for them, and partial when an entry was not read. */
export const readOfNotes = (rows: number, partial: boolean): AssistantRead => ({ tool: 'ai-notes', kind: 'ai-notes', read: true, rows, quality: 'exact', partial });

/** The AI case summary, listed as a read: the rows of the gate's read when the step made one (none when the turn's reading was used). */
export const readOfSummary = (rows: number): AssistantRead => ({ tool: 'ai-summary', kind: 'ai-summary', read: true, rows, quality: 'exact', partial: false });

/** What a read that Ask stopped as heavy would read: the figure it stopped at (a lower bound) and the size of the page a continue reads; absent for a result that is not that stop. */
export function heavyOf(run: AskRunResult): { readonly value: number; readonly page: number } | undefined {
  if (!isHeavyResult(run)) return undefined;
  const { estimate, continueLimit } = (run as { readonly result: { readonly estimate: { readonly value?: number }; readonly continueLimit: number } }).result;
  return estimate.value === undefined ? undefined : { value: estimate.value, page: continueLimit };
}
