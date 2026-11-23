import { EXPORT_HIDDEN_NOTE, notRetrievedText, type SummaryReading, type SummaryResponse, type SummarySentence } from '@neburyx/contracts';
import type { AssembledText } from './assemble.js';

type Draft = Extract<SummaryResponse, { status: 'ok' }>;

/** What the re-read left out, in the words the export header writes it: how many are shown, how much is not yet retrieved, how many references could not be read, and the note that access may hide items. */
export function retrievalLine(reading: SummaryReading): string {
  return [`${reading.nodes.length.toLocaleString('en-US')} shown`, ...unretrievedParts(reading)].join(' · ');
}

/** What is not yet retrieved of a view and what the line says besides: the references that could not be read and the note that access may hide items. */
const unretrievedParts = (reading: SummaryReading): string[] => [
  notRetrievedText(reading.notRetrieved, reading.uncounted),
  ...(reading.unresolved > 0 ? [`${reading.unresolved.toLocaleString('en-US')} references could not be read`] : []),
  ...(reading.omitted ? [EXPORT_HIDDEN_NOTE] : []),
];

const SIGNS = { estimated: '~ ', lowerBound: '≥ ' } as const;

/**
 * The coverage of the view as one citable line, in the words of the export header and with no word of any domain: how many entities it shows (and of which types, by the name the mapping gives each), how many relationships, and what is not yet retrieved.
 * The not-yet-retrieved figure keeps its quality: a sentence that states it must copy it, so it is given with the phrase to copy, or as unknown.
 */
export function viewCoverageOf(reading: SummaryReading, names: ReadonlyMap<string, string> = new Map()): { readonly text: string; readonly inexact?: { readonly phrase: string; readonly value: string } | 'unknown' } {
  const byType = new Map<string, number>();
  for (const node of reading.nodes) byType.set(node.ref.entityType, (byType.get(node.ref.entityType) ?? 0) + 1);
  const types = [...byType].map(([type, count]) => `${count.toLocaleString('en-US')} ${names.get(type) ?? type}`).sort();
  const entities = `${reading.nodes.length.toLocaleString('en-US')} entities shown${types.length === 0 ? '' : ` (${types.join(', ')})`}`;
  const text = [entities, `${reading.edges.length.toLocaleString('en-US')} relationships shown`, ...unretrievedParts(reading)].join(' · ');
  const count = reading.notRetrieved;
  if (count.quality === 'unknown' || count.value === undefined) return { text, inexact: 'unknown' };
  if (count.quality === 'exact') return { text };
  return { text, inexact: { phrase: `${SIGNS[count.quality]}${count.value.toLocaleString('en-US')}`, value: String(count.value) } };
}

/** How much of what is shown the kept sentences cite, counted from their cites. */
export function summaryLine(kept: readonly SummarySentence[], reading: SummaryReading): string {
  if (kept.length === 0) return 'No sentence was kept.';
  const cited = new Set(kept.flatMap((sentence) => sentence.cites)).size;
  const shown = reading.nodes.length + reading.edges.length;
  return `The draft cites ${cited} of the ${shown} shown elements.`;
}

/** The keys the kept sentences cite, each once with its kind and reference, in the order of first use. */
export function citationsOf(kept: readonly SummarySentence[], assembled: AssembledText): Draft['citations'] {
  const seen = new Set<string>();
  const out: Draft['citations'] = [];
  for (const key of kept.flatMap((sentence) => sentence.cites)) {
    const element = assembled.keys.get(key);
    if (seen.has(key) || element === undefined) continue;
    seen.add(key);
    out.push({ key, kind: element.kind, ref: element.ref });
  }
  return out;
}
