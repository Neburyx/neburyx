import type { EdgeRef, ElementRef, SummaryReading } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
import { assembleText } from './assemble.js';
import { judgeSentences } from './checks.js';
import type { OpenedToken } from './token.js';

type Payload = Extract<OpenedToken, { readonly ok: true }>['payload'];

type Cite = { readonly kind: 'entity'; readonly ref: ElementRef } | { readonly kind: 'relationship'; readonly ref: EdgeRef };

export interface KeptSentence {
  /** The sentence's position in the draft, counted from 1. */
  readonly position: number;
  readonly text: string;
  /** The keys of the text assembled from the reading it was judged against. */
  readonly cites: readonly string[];
  readonly refs: readonly Cite[];
}

/**
 * The sentences of a draft that still hold against a fresh reading: a sentence is kept only if every element it cites is in the reading (matched by reference through the token's inputs, never by key) and it passes the checks of
 * the draft against the text assembled from that reading. A draft written unmasked keeps no sentence when the reading masks any property, since a sentence may state a masked value in a form the checks cannot see.
 */
export function rejudge(payload: Payload, reading: SummaryReading): { readonly kept: readonly KeptSentence[]; readonly dropped: number } {
  const nodes = new Map(reading.nodes.map((node) => [canonicalText(node.ref), node]));
  const edges = new Map(reading.edges.map((edge) => [canonicalText(edge.ref), edge]));
  const inputs = new Map(payload.inputRefs.map((sent) => [sent.key, sent]));
  const assembled = assembleText(reading);
  const keyOfRef = new Map([...assembled.keys].map(([key, element]) => [`${element.kind}:${canonicalText(element.ref)}`, key]));
  const draftedBeforeMasking = !payload.mask && [...reading.nodes, ...reading.edges].some((element) => element.properties.some((property) => property.masked));
  const kept: KeptSentence[] = [];
  if (!draftedBeforeMasking) {
    payload.sentences.forEach((sentence, index) => {
      const refs: Cite[] = [];
      const current: string[] = [];
      let whole = sentence.cites.length > 0;
      for (const key of new Set(sentence.cites)) {
        const sent = inputs.get(key);
        const found = sent === undefined ? undefined : sent.kind === 'entity' ? nodes.get(canonicalText(sent.ref)) : edges.get(canonicalText(sent.ref));
        const now = sent === undefined ? undefined : keyOfRef.get(`${sent.kind}:${canonicalText(sent.ref)}`);
        if (sent === undefined || found === undefined || now === undefined) {
          whole = false;
          break;
        }
        current.push(now);
        refs.push(sent.kind === 'entity' ? { kind: 'entity', ref: found.ref as ElementRef } : { kind: 'relationship', ref: found.ref as EdgeRef });
      }
      if (!whole) return;
      const [judged] = judgeSentences([{ text: sentence.text, cites: current }], assembled).kept;
      if (judged !== undefined) kept.push({ position: index + 1, text: judged.text, cites: judged.cites, refs });
    });
  }
  return { kept, dropped: payload.sentences.length - kept.length };
}
