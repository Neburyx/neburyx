import type { SummarySentence } from '@neburyx/contracts';
import type { LabelledCase } from './cases.js';

export interface Score {
  /** The ids of the facts a kept sentence mentions (one of its phrases) while citing a key the fact rests on. */
  readonly factsFound: readonly string[];
  readonly factsMissed: readonly string[];
  /** The ids of the claims a kept sentence makes (one of the claim's phrases). */
  readonly claimsMade: readonly string[];
  /** The invented names a kept sentence holds: names the name check let through. */
  readonly inventedNamesKept: readonly string[];
}

export interface LabelledScore {
  /** The labelled `keep` sentences of the reply that were not kept: good sentences removed wrongly. */
  readonly wronglyRemoved: readonly string[];
  /** The labelled `remove` sentences of the reply that were kept: a sentence a check should have removed and did not. */
  readonly slipped: readonly string[];
}

const lower = (text: string): string => text.toLowerCase();

/** What a set of kept sentences says against the facts, claims and names of a case; `keys` maps the element keys of the case to the keys of the sent text. */
export function scoreSummary(labelled: LabelledCase, kept: readonly SummarySentence[], keys: ReadonlyMap<string, string>): Score {
  const found = labelled.facts.filter((fact) => {
    const resting = new Set(fact.rests_on.flatMap((key) => keys.get(key) ?? []));
    return kept.some((sentence) => fact.phrases.some((phrase) => lower(sentence.text).includes(lower(phrase))) && sentence.cites.some((cite) => resting.has(cite)));
  });
  const foundIds = new Set(found.map((fact) => fact.id));
  const claims = labelled.claims.filter((claim) => kept.some((sentence) => claim.phrases.some((phrase) => lower(sentence.text).includes(lower(phrase)))));
  const invented = labelled.invented_names.filter((name) => kept.some((sentence) => lower(sentence.text).includes(lower(name))));
  return {
    factsFound: found.map((fact) => fact.id),
    factsMissed: labelled.facts.filter((fact) => !foundIds.has(fact.id)).map((fact) => fact.id),
    claimsMade: claims.map((claim) => claim.id),
    inventedNamesKept: invented,
  };
}

const KEY_GROUP = /\s*[(\[]\s*[ne]\d+(?:\s*(?:,|;|and|&)\s*[ne]\d+)*\s*[)\]]/gu;

/** The text of a sentence without the keys the checks take out of a sentence's text, so a sentence whose key was taken out is still the same sentence. */
const plain = (text: string): string => text.replace(KEY_GROUP, '').trim();

const sameCites = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && right.every((cite) => left.includes(cite));

/**
 * The labelled sentences that are in the reply the checks judged, against the sentences kept from that reply. Only that reply counts: a labelled sentence of a reply that a further call replaced is
 * not in `reply` and is not scored. A reply sentence is kept when a kept sentence has the same text (a key taken out of it is ignored) and the same citations.
 */
export function scoreLabelled(labelled: LabelledCase, reply: readonly SummarySentence[], kept: readonly SummarySentence[], keys: ReadonlyMap<string, string>): LabelledScore {
  const wronglyRemoved: string[] = [];
  const slipped: string[] = [];
  for (const sentence of labelled.sentences) {
    const cites = sentence.cites.flatMap((key) => keys.get(key) ?? []);
    const inReply = reply.some((held) => plain(held.text) === sentence.text && sameCites(held.cites, cites));
    if (!inReply) continue;
    const isKept = kept.some((held) => plain(held.text) === sentence.text && sameCites(held.cites, cites));
    if (sentence.label === 'keep' && !isKept) wronglyRemoved.push(sentence.id);
    if (sentence.label === 'remove' && isKept) slipped.push(sentence.id);
  }
  return { wronglyRemoved, slipped };
}
