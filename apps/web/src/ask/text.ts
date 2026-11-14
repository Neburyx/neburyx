import type { AskRefusalCause } from '@neburyx/contracts';
import { ASK_REFUSAL_CAUSES } from '@neburyx/contracts';

/** A name of the folder as words: `accounts-paid-by` is "Accounts paid by", `personId` is "Person ID". */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  const words = spaced.split(/\s+/).map((word) => (word.toLowerCase() === 'id' ? 'ID' : word.toLowerCase()));
  const text = words.join(' ');
  return text === '' ? name : text.charAt(0).toUpperCase() + text.slice(1);
}

const CAUSE_LABELS: Readonly<Record<AskRefusalCause, string>> = {
  'no-intent': 'No question type',
  'unknown-intent': 'Unknown question type',
  'bad-reply': 'Bad reply',
  'model-declined': 'Model declined',
  'model-failed': 'Model failed',
  'no-ask-for-source': 'No Ask for this source',
  unavailable: 'Unavailable',
  'missing-inputs': 'Missing inputs',
  'extra-inputs': 'Extra inputs',
  'invalid-inputs': 'Invalid inputs',
  'nothing-found': 'Nothing found',
};

/** The tag of a refusal card: the cause's number in the list of causes and its label. */
export const causeTag = (cause: AskRefusalCause): string => `${ASK_REFUSAL_CAUSES.indexOf(cause) + 1} · ${CAUSE_LABELS[cause]}`;

/** What to try next, for the causes where the person can do something about the question; none for the others. */
const HINTS: Readonly<Partial<Record<AskRefusalCause, string>>> = {
  'no-intent': 'Try naming the kind of thing you ask about and its ID.',
  'unknown-intent': 'Try naming the kind of thing you ask about and its ID.',
  'model-declined': 'Try rewording the question.',
  'missing-inputs': 'Try naming the thing you ask about by its ID.',
  'extra-inputs': 'Try leaving out what is not needed.',
  'invalid-inputs': 'Check the ID and try again.',
  'nothing-found': 'Try another ID, or search by hand.',
};

export const hintOf = (cause: AskRefusalCause): string | undefined => HINTS[cause];

/** The causes whose card shows the lines of the intent's inputs. */
export const SHOWS_INPUTS: ReadonlySet<AskRefusalCause> = new Set<AskRefusalCause>(['missing-inputs', 'extra-inputs', 'invalid-inputs']);
