import { EXPORT_HIDDEN_NOTE, notRetrievedText, type SummaryReading, type SummaryResponse, type SummarySentence } from '@neburyx/contracts';
import type { AssembledText } from './assemble.js';

type Draft = Extract<SummaryResponse, { status: 'ok' }>;

/** What the re-read left out, in the words the export header writes it: how many are shown, how much is not yet retrieved, how many references could not be read, and the note that access may hide items. */
export function retrievalLine(reading: SummaryReading): string {
  const parts = [`${reading.nodes.length.toLocaleString('en-US')} shown`, notRetrievedText(reading.notRetrieved, reading.uncounted)];
  if (reading.unresolved > 0) parts.push(`${reading.unresolved.toLocaleString('en-US')} references could not be read`);
  if (reading.omitted) parts.push(EXPORT_HIDDEN_NOTE);
  return parts.join(' · ');
}

/** The coverage of the view as one citable line: how many entities and how many relationships it shows, and what is not yet retrieved, in the words of the export header and with no word of any domain. */
export function viewCoverageText(reading: SummaryReading): string {
  const shown = (count: number, kind: string): string => `${count.toLocaleString('en-US')} ${kind} shown`;
  const parts = [shown(reading.nodes.length, 'entities'), shown(reading.edges.length, 'relationships'), notRetrievedText(reading.notRetrieved, reading.uncounted)];
  if (reading.unresolved > 0) parts.push(`${reading.unresolved.toLocaleString('en-US')} references could not be read`);
  if (reading.omitted) parts.push(EXPORT_HIDDEN_NOTE);
  return parts.join(' · ');
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
