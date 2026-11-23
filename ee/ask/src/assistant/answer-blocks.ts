import type { AssistantBlocks } from '@neburyx/contracts';
import { labelsHold } from './table.js';
import { withinTotals, type KeptBlock } from './blocks.js';
import type { AnswerBasis, ToolAnswerOutcome } from './tool-answer.js';

type Judged = Extract<ToolAnswerOutcome, { kind: 'sentences' | 'table' }>;
/** The headings a list may carry besides plain words of the text sent: neutral fixed copy of the code, so that the heading of a list of where an answer came from reads as a heading and never as a claim. */
const LIST_HEADINGS: ReadonlySet<string> = new Set(['where it came from', 'details', 'notes']);

/** A block that was judged: a list is a sentences outcome whose items were judged as sentences, with the label the model gave it. */
export type JudgedBlock = Judged | (Extract<Judged, { kind: 'sentences' }> & { readonly list: true; readonly label?: string });

/** What the blocks of one answer come to: the blocks, the citations they name (once each, in the order of their first citation), the two coverage lines the server writes, and the model. */
export interface BlocksAnswer {
  readonly blocks: AssistantBlocks;
  readonly citations: Judged['citations'];
  readonly coverage: { readonly retrieval: string; readonly summary: string };
  readonly model: string;
  readonly noDescription?: string;
  readonly pointer?: string;
  readonly lastCallNote?: string;
  /** The blocks the totals left out. */
  readonly leftOut: number;
  /** Items of lists the total of 12 cut from the end. */
  readonly itemsCut: number;
  /** Labels of lists that were not shown because no word of the text sent backs them. */
  readonly labelsRemoved: number;
}

/** The answer of the blocks the checks kept, each already judged alone: the totals of the answer are applied, and the citations and the coverage are those of what is left. Undefined when no block is left. */
export function combineOutcomes(outcomes: readonly JudgedBlock[], basis: AnswerBasis, droppedWithTable = 0): BlocksAnswer | undefined {
  const first = outcomes[0];
  if (first === undefined) return undefined;
  let labelsRemoved = 0;
  const kept: KeptBlock[] = outcomes.map((outcome): KeptBlock => {
    if (outcome.kind === 'table') return { kind: 'table', table: outcome.table, summary: outcome.coverage.summary };
    if (!('list' in outcome)) return { kind: 'sentences', sentences: outcome.sentences };
    const labelHolds = outcome.label !== undefined && (LIST_HEADINGS.has(outcome.label.trim().toLowerCase()) || labelsHold([outcome.label], basis.checkedText.text));
    if (outcome.label !== undefined && !labelHolds) labelsRemoved += 1;
    return { kind: 'list', ...(labelHolds && outcome.label !== undefined ? { label: outcome.label } : {}), items: outcome.sentences };
  });
  const totalled = withinTotals(kept);
  const { leftOut, itemsCut, summaries } = totalled;
  const firstTable = totalled.blocks.findIndex((block) => block.kind === 'table');
  const blocks = totalled.blocks.map((block, index) => (index === firstTable && block.kind === 'table' && droppedWithTable > 0 ? { ...block, table: { ...block.table, droppedRows: (block.table.droppedRows ?? 0) + droppedWithTable } } : block));
  if (blocks.length === 0) return undefined;
  const known = new Map(outcomes.flatMap((outcome) => outcome.citations.map((citation) => [citation.key, citation] as const)));
  const keys = blocks.flatMap((block) => (block.kind === 'sentences' ? block.sentences.flatMap((sentence) => sentence.cites) : block.kind === 'list' ? block.items.flatMap((item) => item.cites) : block.table.rows.flatMap((row) => row.cites)));
  const citations = [...new Set(keys)].flatMap((key) => {
    const citation = known.get(key);
    return citation === undefined ? [] : [citation];
  });
  const elements = citations.filter((citation) => citation.kind !== 'description' && citation.kind !== 'read').length;
  const summary = summaries.length > 0 ? summaries.join(' ') : `The answer cites ${elements} of the ${basis.assembled.keys.size} elements the reads returned.`;
  const noDescription = outcomes.find((outcome) => outcome.noDescription !== undefined)?.noDescription;
  return { blocks, citations, coverage: { retrieval: first.coverage.retrieval, summary }, model: first.model, leftOut, itemsCut, labelsRemoved, ...(noDescription === undefined ? {} : { noDescription }) };
}
