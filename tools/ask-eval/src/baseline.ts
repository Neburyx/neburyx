import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Question } from './questions.js';
import type { Tally } from './targets.js';

export const BASELINE_MODES = ['replay', 'live'] as const;
export type BaselineMode = (typeof BASELINE_MODES)[number];

const valueSchema = z.strictObject({ plansRight: z.number().int().min(0), refusalsRefused: z.number().int().min(0) });
const baselineSchema = z.strictObject({ format: z.literal(1), questionsHash: z.string().regex(/^[0-9a-f]{64}$/), modes: z.strictObject({ replay: valueSchema.optional(), live: valueSchema.optional() }) });

export type BaselineValue = z.infer<typeof valueSchema>;
export type Baseline = z.infer<typeof baselineSchema>;

export class BaselineError extends Error {}

export function questionsHashOf(questions: readonly Question[]): string {
  return createHash('sha256').update([...questions.map((question) => question.id)].sort().join('\n')).digest('hex');
}

export function parseBaseline(text: string, questions: readonly Question[]): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BaselineError('the baseline file is not valid JSON');
  }
  const parsed = baselineSchema.safeParse(data);
  if (!parsed.success) throw new BaselineError('the baseline file is malformed or of an unknown format');
  if (parsed.data.questionsHash !== questionsHashOf(questions)) throw new BaselineError('the baseline file was made for another question set');
  return parsed.data;
}

export function loadBaseline(path: string, questions: readonly Question[]): Baseline | undefined {
  return existsSync(path) ? parseBaseline(readFileSync(path, 'utf8'), questions) : undefined;
}

export function valueOf(found: Tally): BaselineValue {
  return { plansRight: found.plans.right, refusalsRefused: found.refusals.refused };
}

export function belowBaseline(found: Tally, baseline: BaselineValue | undefined): boolean {
  return baseline !== undefined && (found.plans.right < baseline.plansRight || found.refusals.refused < baseline.refusalsRefused);
}

/** Writes the result as the baseline of the mode when it is not lower than the one there; never writes a lower value. */
export function updateBaseline(path: string, questions: readonly Question[], mode: BaselineMode, found: Tally): void {
  const existing = loadBaseline(path, questions);
  const next = valueOf(found);
  const current = existing?.modes[mode];
  if (current !== undefined && (next.plansRight < current.plansRight || next.refusalsRefused < current.refusalsRefused)) throw new BaselineError('the result is lower than the baseline of the mode; the baseline is not lowered');
  const written: Baseline = { format: 1, questionsHash: questionsHashOf(questions), modes: { ...existing?.modes, [mode]: next } };
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
}
