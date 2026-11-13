import { readFileSync } from 'node:fs';
import { ASK_PLAN_PARAMS, ASK_PLAN_TEMPLATE_IDS } from '@neburyx/contracts';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { REFUSAL_FAMILIES } from './families.js';

const expectedPlanSchema = z.strictObject({ kind: z.literal('plan'), template: z.enum(ASK_PLAN_TEMPLATE_IDS), params: z.record(z.string(), z.unknown()) });
const expectedRefusalSchema = z.strictObject({ kind: z.literal('unsupported'), family: z.enum(REFUSAL_FAMILIES).optional() });
const expectedBlockedSchema = z.strictObject({ kind: z.literal('blocked') });

export const questionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  pack: z.string().min(1).optional(),
  wording: z.string().min(1),
  expect: z.discriminatedUnion('kind', [expectedPlanSchema, expectedRefusalSchema, expectedBlockedSchema]),
});

export const questionFileSchema = z.strictObject({ questions: z.array(questionSchema).min(1) });

export type Question = z.infer<typeof questionSchema>;
export type Expectation = Question['expect'];

export class QuestionFileError extends Error {}

function describe(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

function lineOf(document: ReturnType<typeof parseDocument>, lines: LineCounter, path: readonly PropertyKey[]): number {
  for (let length = path.length; length >= 0; length -= 1) {
    const node: unknown = document.getIn(path.slice(0, length).filter((key): key is string | number => typeof key !== 'symbol'), true);
    const range: unknown = typeof node === 'object' && node !== null ? Reflect.get(node, 'range') : undefined;
    if (Array.isArray(range) && typeof range[0] === 'number') return lines.linePos(range[0]).line;
  }
  return 1;
}

export function parseQuestions(text: string): readonly Question[] {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines });
  const [syntax] = document.errors;
  if (syntax !== undefined) throw new QuestionFileError(`the question file is not valid YAML at line ${syntax.linePos?.[0].line ?? 1}`);
  const parsed = questionFileSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new QuestionFileError(issue === undefined ? 'the question file is malformed' : `the question file is malformed at line ${lineOf(document, lines, issue.path)}, field ${describe(issue.path)}`);
  }
  const seen = new Set<string>();
  for (const question of parsed.data.questions) {
    if (seen.has(question.id)) throw new QuestionFileError(`the question id ${question.id} is used twice`);
    seen.add(question.id);
    if (question.expect.kind === 'plan' && !ASK_PLAN_PARAMS[question.expect.template].safeParse(question.expect.params).success) {
      throw new QuestionFileError(`the expected plan of ${question.id} does not fit its template`);
    }
  }
  return parsed.data.questions;
}

export function loadQuestions(path: string): readonly Question[] {
  return parseQuestions(readFileSync(path, 'utf8'));
}
