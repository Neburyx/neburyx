import type { RejectedSentence, RemovalReason } from './reply-checks.js';

const EXPLANATION: Readonly<Record<RemovalReason, string>> = {
  verdict: 'it states a conclusion about guilt, intent or an offence; describe only what the elements show',
  key: 'it writes an element key in the sentence; keys belong in the list of citations only',
  citation: 'it cites nothing, or cites a key that was not sent',
  number: 'a number in it is not on the lines it cites and is not the count of the cited elements of the type it names',
  count: 'it states a number for a count that is not known, or an estimated or lower-bound count without its label as written',
  comparison: 'it compares or ranks elements that the lines it cites do not all show',
  name: 'it holds a name, an identifier or a quoted text that the text sent does not hold',
  label: 'a column label of the table is not a word of the text sent',
  cell: 'a number in a cell of the row is not on the lines the row cites; in a table the count of the cited elements does not stand for it',
  row: 'the row cites a line that is no element a read returned (a line of a read, a meaning or a note), which a row may not rest on',
};

/** What the model is told of the sentences that were removed: each sentence as it wrote it, and the fixed words of the reason. Nothing else is added. */
export function removalNoteOf(rejected: readonly RejectedSentence[]): string {
  return rejected.map((each) => `Removed: ${JSON.stringify(each.text)} (${EXPLANATION[each.reason]}).`).join('\n');
}
