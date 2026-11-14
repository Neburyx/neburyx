import type { AskClassification } from '@neburyx/contracts';
import type { EvalHooks, RecordedAnswer } from './hooks.js';
import { replayOf } from './replay-file.js';
import type { Replay } from './replay-file.js';
import type { Question } from './questions.js';
import type { SourceSet } from './sets.js';

/** The ways a question can be missed: the classifier's own causes, and these. */
export type MissCause = string;

export interface Scored {
  readonly name: string;
  readonly expect: 'refuse' | 'plan';
  /** Undefined when the question was answered as expected. */
  readonly miss?: MissCause;
  /** For a plan question: the classifier refused it with the cause `no-intent`. */
  readonly unsupported: boolean;
}

/** At most this many plan misses are allowed: `floor(plans × 8 / 100)`, in integers, so 92% of the plans are right. */
export const allowedMisses = (plans: number): number => Math.floor((plans * 8) / 100);

const sameEntities = (left: Readonly<Record<string, string | number | boolean>>, right: Readonly<Record<string, string>>): boolean => {
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every((name) => right[name] === left[name]);
};

export function verdictOf(question: Question, answer: AskClassification | undefined): { readonly miss?: MissCause; readonly unsupported: boolean } {
  if (answer === undefined) return { miss: 'no-reply', unsupported: false };
  const unsupported = !answer.ok && answer.cause === 'no-intent';
  if (question.expect === 'refuse') return answer.ok ? { miss: 'answered', unsupported: false } : answer.cause === 'no-intent' ? { unsupported: false } : { miss: answer.cause, unsupported: false };
  if (!answer.ok) return { miss: answer.cause, unsupported };
  if (answer.intent !== question.expect.intent) return { miss: 'wrong-intent', unsupported };
  return sameEntities(answer.entities, question.expect.entities) ? { unsupported } : { miss: 'wrong-entities', unsupported };
}

/** Scores a replay with the product's own classifier: a question with no recorded answer is `no-reply`; every other answer is the classifier's reading of the recorded reply. */
export async function scoreReplay(sets: readonly SourceSet[], replay: Replay, hooks: EvalHooks): Promise<Scored[]> {
  const answers = replayOf(replay);
  const provider = hooks.replayProvider(answers as ReadonlyMap<string, RecordedAnswer>);
  const scored: Scored[] = [];
  for (const set of sets) {
    for (const question of set.questions) {
      const recorded = answers.has(question.wording) ? await hooks.classify(set.source, provider, 'replay', question.wording) : undefined;
      scored.push({ name: `${set.label}/${question.id}`, expect: question.expect === 'refuse' ? 'refuse' : 'plan', ...verdictOf(question, recorded) });
    }
  }
  return scored;
}
