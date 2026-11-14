import { parse } from 'yaml';
import { z } from 'zod';

const MAX_WORDING_CODE_POINTS = 1000;

export class UsageError extends Error {}

type Expect = 'refuse' | { readonly intent: string; readonly entities: Readonly<Record<string, string>> };

export interface Question {
  readonly id: string;
  readonly wording: string;
  readonly expect: Expect;
}

const expectSchema = z.union([z.literal('refuse'), z.strictObject({ intent: z.string().min(1), entities: z.record(z.string(), z.string()) })]);
const fileSchema = z.strictObject({ questions: z.array(z.strictObject({ id: z.string().min(1), wording: z.string(), expect: expectSchema })) });

/** Reads a question file strictly. A problem names the question's id (or its place) and never repeats a wording or a value. */
export function readQuestions(text: string): readonly Question[] {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    throw new UsageError('the question file is not valid YAML');
  }
  const read = fileSchema.safeParse(data);
  if (!read.success) throw new UsageError(`the question file is not in the expected form: ${read.error.issues[0]?.path.join('.') ?? ''}`);
  const seen = new Set<string>();
  for (const question of read.data.questions) {
    if (seen.has(question.id)) throw new UsageError(`the id ${question.id} is used twice`);
    seen.add(question.id);
    if (question.wording.trim() === '') throw new UsageError(`the question ${question.id} has an empty wording`);
    if ([...question.wording].length > MAX_WORDING_CODE_POINTS) throw new UsageError(`the question ${question.id} is longer than ${MAX_WORDING_CODE_POINTS} code points`);
  }
  return read.data.questions;
}
