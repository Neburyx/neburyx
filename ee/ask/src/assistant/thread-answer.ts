import type { AssistantThreadTurnWrite, AssistantTurnAnswer, StoredAnswer } from '@neburyx/contracts';

type Form = 'frozen' | 'unbound';
type Cite = AssistantThreadTurnWrite['citationRefs'][number];
type Sentence = { readonly text: string; readonly cites: readonly string[] };
type Citation = { readonly key: string; readonly kind: string; readonly ref?: Cite };

/** The element a key of an answer stands for, when the key is one of an element or a relationship (not a read, not a meaning); the references the thread already keeps. */
const refsOf = (citations: readonly Citation[]): Map<string, Cite> => new Map(citations.flatMap((citation) => (citation.ref === undefined || citation.kind === 'read' || citation.kind === 'description' ? [] : [[citation.key, citation.ref] as const])));

/**
 * The stored form of an answer that a turn ended with, or nothing for an answer that has no stored form yet. A turn written with the mask on is stored as it was shown, every item `frozen`; a turn written with the mask off is stored whole and every
 * item is `unbound`, until the binding of values keeps what can be kept as references: an `unbound` item is never returned while the mask is on. The fixed sentences of the server are kept as they are written, `frozen`, in either case.
 * Only the answers that carry sentences, a table or a refusal have a form here; the other shapes join when the answer is one list of blocks.
 */
export function storedAnswerOf(answer: AssistantTurnAnswer, maskOn: boolean): StoredAnswer | undefined {
  const item: Form = maskOn ? 'frozen' : 'unbound';
  const fixed: Form = 'frozen';
  const sentences = (list: readonly Sentence[], refs: ReadonlyMap<string, Cite>, form: Form) => list.map((sentence) => ({ form, text: sentence.text, cites: sentence.cites.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : [])) }));
  if (answer.status === 'not-answered') return { blocks: [{ kind: 'refusal', sentence: { form: fixed, text: answer.sentence } }] };
  if (answer.status !== 'answered') return undefined;
  if (answer.route === 'refuse') {
    const refs = answer.overview === undefined ? new Map<string, Cite>() : refsOf(answer.overview.citations);
    return { blocks: [{ kind: 'refusal', sentence: { form: fixed, text: answer.sentence }, ...(answer.overview === undefined ? {} : { overview: sentences(answer.overview.sentences, refs, item) }) }] };
  }
  if (!('citations' in answer)) return undefined;
  const refs = refsOf(answer.citations);
  // the fixed sentences of the server (a type with no description, a pointer, the note of the last call) are a block of their own, kept as written
  const server = [answer.noDescription, answer.pointer, answer.lastCallNote].flatMap((text) => (text === undefined || text === '' ? [] : [{ form: fixed, text, cites: [] as Cite[] }]));
  const fixedBlock = server.length === 0 ? [] : [{ kind: 'sentences' as const, items: server }];
  if ('table' in answer) {
    const { table } = answer;
    return { blocks: [{ kind: 'table', columns: table.columns.map((label) => ({ form: item, text: label })), rows: table.rows.map((row) => ({ cells: row.cells.map((cell) => ({ form: item, text: cell })), cites: row.cites.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : [])) })) }, ...fixedBlock] };
  }
  if (!('sentences' in answer)) return undefined;
  return { blocks: [{ kind: 'sentences', items: sentences(answer.sentences, refs, item) }, ...fixedBlock] };
}
