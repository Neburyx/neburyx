import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Result } from './report.js';
import { UsageError } from './questions.js';
import type { SourceSet } from './sets.js';

const valueSchema = z.strictObject({ questions: z.string().regex(/^[0-9a-f]{64}$/), refusals: z.number().int().min(0), plans: z.number().int().min(0) });
const baselineSchema = z.strictObject({ replay: valueSchema.optional() });

export type Baseline = z.infer<typeof baselineSchema>;

/** A hash of the question files of the run, so that a baseline made for other questions is refused. */
export function questionsHash(sets: readonly SourceSet[]): string {
  const parts = sets.flatMap((set) => set.questions.map((question) => JSON.stringify([set.label, question.id, question.wording, question.expect]))).sort();
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export function parseBaseline(text: string): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError('the baseline is not valid JSON');
  }
  const read = baselineSchema.safeParse(data);
  if (!read.success) throw new UsageError('the baseline is not in the expected form');
  return read.data;
}

/** The problem with a run against its baseline, or undefined when there is none: no value yet, or both counts held. */
export function belowBaseline(baseline: Baseline, sets: readonly SourceSet[], result: Result): string | undefined {
  const value = baseline.replay;
  if (value === undefined) return undefined;
  if (value.questions !== questionsHash(sets)) throw new UsageError('the baseline was made for other questions');
  if (result.refusals.refused < value.refusals) return `refusals refused ${result.refusals.refused} is below the baseline ${value.refusals}`;
  if (result.plans.right < value.plans) return `plans right ${result.plans.right} is below the baseline ${value.plans}`;
  return undefined;
}

/** The baseline a run may write: only from a run that meets its targets and is not scripted, and never lower than the one it replaces. */
export function updatedBaseline(previous: Baseline, sets: readonly SourceSet[], result: Result): Baseline {
  if (result.scripted) throw new UsageError('a baseline is not written from a scripted replay');
  if (!result.targetsMet) throw new UsageError('a baseline is written only from a run that meets its targets');
  const old = previous.replay;
  if (old !== undefined && old.questions === questionsHash(sets) && (result.refusals.refused < old.refusals || result.plans.right < old.plans)) throw new UsageError('a baseline is never written lower');
  return { replay: { questions: questionsHash(sets), refusals: result.refusals.refused, plans: result.plans.right } };
}
