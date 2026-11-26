import type { RejectedSentence, RemovalReason } from './reply-checks.js';

const EXPLANATION: Readonly<Record<RemovalReason, string>> = {
  verdict: 'it states a conclusion about guilt, intent or an offence; describe only what the elements show',
  key: 'it writes an element key in the sentence; keys belong in the list of citations only',
  citation: 'it cites nothing, or cites a key that was not sent, or says that something is absent or not shown, speaks of all of a set, or describes what a read returned, without citing the line or the elements that back it, or is too long to be checked (write shorter sentences, each with its own citations); or it says that something belongs to a named element (a possessive, or "of" the name) without citing a relationship that joins that element: cite a relationship that joins it',
  number: 'a number in it is not on the lines it cites and is not the count of the cited elements of the type it names',
  count: 'it states a number for a count that is not known, or an estimated or lower-bound count without its label as written',
  comparison: 'it compares elements that the lines it cites do not all show, or ranks them (the largest, the smallest, the top, the latest, the earliest, the most or the fewest) in a way that cannot be verified against the cited values: a tie, a value that is missing, masked or of another kind, an element that was not cited, or a property that is not named once; or it says that elements differ, are the same or share something that the cited elements do not show: cite every element compared and the relationships that join them, name the property or the connected element, when it says that they differ, that none have one in common or that only one is in common, limit that statement to what you have with the words "in view" or "among those read"; state a ranking or comparison without words for how large the gap is, and give the cited values instead; or leave the sentence out',
  name: 'it holds a name, an identifier or a quoted text that the text sent does not hold',
  label: 'a column label of the table is not a word of the text sent',
  cell: 'a number in a cell of the row is not on the lines the row cites; in a table the count of the cited elements does not stand for it',
  row: 'the row cites a line that is no element a read returned (a line of a read, a meaning or a note), which a row may not rest on',
};

/** What the model is told of the sentences that were removed: each sentence as it wrote it, and the fixed words of the reason. Nothing else is added. */
export function removalNoteOf(rejected: readonly RejectedSentence[]): string {
  return rejected.map((each) => `Removed: ${JSON.stringify(each.text)} (${EXPLANATION[each.reason]}).`).join('\n');
}
