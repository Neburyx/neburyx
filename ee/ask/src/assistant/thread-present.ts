import type { AssistantThreadResponse, ReadAnswer, StoredAnswer, StoredTurnText } from '@neburyx/contracts';
import type { AssistantThreadRead } from './thread-store.js';

type StoredItem = StoredAnswer['blocks'][number] extends infer Block ? (Block extends { readonly items: readonly (infer Item)[] } ? Item : never) : never;
type ReadItem = ReadAnswer['blocks'][number] extends infer Block ? (Block extends { readonly items: readonly { readonly item: infer Item }[] } ? Item : never) : never;

const WITHHELD = { state: 'withheld' } as const;

/**
 * What a read may send of one item of a stored answer. Under the mask an item that may hold a sensitive value is withheld, so that no text of it leaves: that is every item of a turn whose sensitivity version is not known to be the current one,
 * and every `unbound` item; an item that is bound is sent as segments (never with a value: the panel draws it from the element read again under the current mask), and a frozen one as stored. With the mask off
 * every item is sent as stored.
 */
function presentItem(item: { readonly form: string; readonly text?: string; readonly segments?: readonly unknown[] }, maskNow: boolean, verified: boolean): ReadItem {
  if (maskNow && !verified) return WITHHELD;
  if (item.form === 'bound') return { state: 'segments', segments: (item.segments ?? []) as never };
  // an unbound item is never sent under the mask, whatever mask it was written under
  if (maskNow && item.form === 'unbound') return WITHHELD;
  return { state: 'text', text: item.text ?? '' };
}

type StoredAskBlock = Extract<StoredAnswer['blocks'][number], { kind: 'ask-result' }>;
type ReadAskBlock = Extract<ReadAnswer['blocks'][number], { kind: 'ask-result' }>;

/**
 * A stored result as a read sends it: counts, references and the typed values as stored; a frozen text (the masked rows of a result written with the mask on) is withheld, as a frozen sentence is, when the mask is on and the sensitivity of the mapping is not known
 * to be the one it was written under, since a title that was public then may be sensitive now.
 */
function presentAskResult(block: StoredAskBlock, withhold: boolean): ReadAskBlock {
  const hide = <T extends { readonly form: string }>(item: T): T | { readonly form: 'withheld' } => (withhold && item.form === 'frozen' ? { form: 'withheld' } : item);
  return {
    ...block,
    rows: block.rows.map(hide),
    lines: block.lines.map((entry) => (entry.item === undefined ? entry : { ...entry, item: hide(entry.item) })),
    paths: block.paths.map((entry) => ({ ...entry, steps: entry.steps.map((step) => ({ ...step, from: hide(step.from), to: hide(step.to) })) })),
  } as ReadAskBlock;
}

function presentAnswer(stored: StoredTurnText, maskNow: boolean, verified: boolean): ReadAnswer | undefined {
  const { answer } = stored;
  if (answer === undefined) return undefined;
  const item = (value: Parameters<typeof presentItem>[0]) => presentItem(value, maskNow, verified);
  const labelOf = (value: Parameters<typeof presentItem>[0]) => {
    const shown = item(value);
    return shown.state === 'segments' ? WITHHELD : shown;
  };
  return {
    ...(answer.model === undefined ? {} : { model: answer.model }),
    ...(answer.coverage === undefined ? {} : { coverage: answer.coverage }),
    blocks: answer.blocks.map((block): ReadAnswer['blocks'][number] => {
      if (block.kind === 'sentences') return { kind: 'sentences', items: block.items.map((sentence: StoredItem & { readonly cites: readonly unknown[] }) => ({ item: item(sentence), cites: sentence.cites as never })) };
      if (block.kind === 'ask-result') return presentAskResult(block, maskNow && !verified);
      if (block.kind === 'list') return { kind: 'list', ...(block.label === undefined ? {} : { label: labelOf(block.label) }), items: block.items.map((entry: StoredItem & { readonly cites: readonly unknown[] }) => ({ item: item(entry), cites: entry.cites as never })) };
      if (block.kind === 'table') return { kind: 'table', columns: block.columns.map(labelOf), rows: block.rows.map((row) => ({ cells: row.cells.map(item), cites: row.cites })) };
      return { kind: 'refusal', sentence: labelOf(block.sentence), ...(block.overview === undefined ? {} : { overview: block.overview.map((sentence) => ({ item: item(sentence), cites: sentence.cites })) }) };
    }),
  };
}

/**
 * The thread as it is sent: each turn with its question as typed (the person's own text; the mask does not change it) and its answer, item by item, as the mask asked for in this read and the sensitivity version of the mapping allow. A turn kept
 * before text was kept, or one with no answer, has no answer; the version is verified only when it is known and equals the current one.
 */
export function presentThread(read: AssistantThreadRead, maskNow: boolean, currentVersion: string | undefined): AssistantThreadResponse {
  return {
    turns: read.turns.map(({ stored, ...turn }) => {
      if (stored === undefined) return turn;
      const verified = stored.sensitivityVersion !== undefined && currentVersion !== undefined && stored.sensitivityVersion === currentVersion;
      const answer = presentAnswer(stored, maskNow, verified);
      return { ...turn, ...(stored.question === undefined ? {} : { question: stored.question }), ...(answer === undefined ? {} : { answer }) };
    }),
    earlierTurns: read.earlierTurns,
    previousThreadClearedAt: read.previousThreadClearedAt,
  };
}
