import type { SummarySentence } from '@neburyx/contracts';
import type { LabelledCase } from '../cases.js';
import { offenceWordsIn } from '../checks.js';

const KEY_GROUP = /\s*[(\[]\s*[ne]\d+(?:\s*(?:,|;|and|&)\s*[ne]\d+)*\s*[)\]]/gu;
const plain = (text: string): string => text.replace(KEY_GROUP, '').trim();

/** The reply sentences the checks removed: those with no kept sentence of the same text (a key taken out of the text is ignored) and the same citations. */
export function removedOf(written: readonly SummarySentence[], kept: readonly SummarySentence[]): SummarySentence[] {
  const remaining = [...kept];
  return written.filter((sentence) => {
    const found = remaining.findIndex((held) => plain(held.text) === plain(sentence.text) && held.cites.length === sentence.cites.length && sentence.cites.every((cite) => held.cites.includes(cite)));
    if (found < 0) return true;
    remaining.splice(found, 1);
    return false;
  });
}

const lower = (text: string): string => text.toLowerCase();

/** The text with each title and id of the view taken out, longest first: what is left says what the sentence says besides the names of its elements. */
function withoutNames(text: string, labelled: LabelledCase): string {
  const names = labelled.entities.flatMap((entity) => [entity.name, entity.id]).filter((name, index, all) => all.indexOf(name) === index).sort((left, right) => right.length - left.length);
  return names.reduce((left, name) => left.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu'), ' '), text);
}

export type RemovalCause = 'verdictInTitle' | 'forReview' | 'other';

/**
 * Why a removed sentence was removed, as far as the command can tell by itself. `verdictInTitle`: it holds verdict wording, and all of it lies inside the title or id of an element of the view. `forReview`: it states a
 * fact of the view and cites an element the fact rests on, and holds no claim, no invented name and no verdict wording outside a title, so that no cause the command knows explains its removal: a person reads it.
 * Anything else is `other` (it was removed for a cause the command can see, such as a verdict outside a title or a number nothing supports).
 */
export function causeOf(sentence: SummarySentence, labelled: LabelledCase, keys: ReadonlyMap<string, string>): { readonly cause: RemovalCause; readonly factId?: string } {
  const hits = offenceWordsIn(sentence.text);
  const outside = offenceWordsIn(withoutNames(sentence.text, labelled));
  if (hits.length > 0 && outside.length === 0) return { cause: 'verdictInTitle' };
  if (outside.length > 0) return { cause: 'other' };
  const claimed = labelled.claims.some((claim) => claim.phrases.some((phrase) => lower(sentence.text).includes(lower(phrase))));
  const invented = labelled.invented_names.some((name) => lower(sentence.text).includes(lower(name)));
  if (claimed || invented) return { cause: 'other' };
  for (const fact of labelled.facts) {
    const resting = new Set(fact.rests_on.flatMap((key) => keys.get(key) ?? []));
    if (fact.phrases.some((phrase) => lower(sentence.text).includes(lower(phrase))) && sentence.cites.some((cite) => resting.has(cite))) return { cause: 'forReview', factId: fact.id };
  }
  return { cause: 'other' };
}
