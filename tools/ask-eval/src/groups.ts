import { z } from 'zod';
import type { Question } from './questions.js';
import type { QuestionResult } from './run.js';

const UNSPECIFIED = 'unspecified';

const count = z.number().int().min(0);

export const runSummarySchema = z.strictObject({
  refusals: z.strictObject({ total: count, refused: count }),
  plans: z.strictObject({ total: count, right: count, maxMisses: count }),
  blocked: z.strictObject({ total: count, blocked: count }),
  family: z.strictObject({ measured: z.boolean(), asked: count, right: count }),
  repaired: count,
  targets: z.strictObject({ refusalsMet: z.boolean(), plansMet: z.boolean(), blockedMet: z.boolean() }),
  baseline: z.strictObject({ mode: z.enum(['replay', 'live']), value: z.strictObject({ plansRight: count, refusalsRefused: count }).nullable(), missed: z.boolean() }),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

export const reportSchema = z.strictObject({
  summary: runSummarySchema,
  overall: z.strictObject({ total: z.number().int(), answeredUnsupported: z.number().int(), blocked: z.number().int() }),
  byFamily: z.array(z.strictObject({ family: z.string(), refused: z.number().int(), wronglyPlanned: z.number().int(), other: z.number().int() })),
  byTemplate: z.array(z.strictObject({ template: z.string(), right: z.number().int(), wrong: z.number().int(), refused: z.number().int() })),
  questions: z.array(z.strictObject({ id: z.string(), verdict: z.string(), fields: z.array(z.string()) })),
});

export type Report = z.infer<typeof reportSchema>;

export function groupReport(questions: readonly Question[], results: readonly QuestionResult[], summary: RunSummary): Report {
  const expectOf = new Map(questions.map((question) => [question.id, question.expect] as const));
  const families = new Map<string, { refused: number; wronglyPlanned: number; other: number }>();
  const templates = new Map<string, { right: number; wrong: number; refused: number }>();
  for (const result of results) {
    const expect = expectOf.get(result.id);
    if (expect?.kind === 'unsupported') {
      const group = families.get(expect.family ?? UNSPECIFIED) ?? { refused: 0, wronglyPlanned: 0, other: 0 };
      if (result.verdict === 'refused') group.refused += 1;
      else if (result.verdict === 'wrongly-planned') group.wronglyPlanned += 1;
      else group.other += 1;
      families.set(expect.family ?? UNSPECIFIED, group);
    }
    if (expect?.kind === 'plan') {
      const group = templates.get(expect.template) ?? { right: 0, wrong: 0, refused: 0 };
      if (result.verdict === 'right') group.right += 1;
      else if (result.answered === 'unsupported') group.refused += 1;
      else group.wrong += 1;
      templates.set(expect.template, group);
    }
  }
  return {
    summary,
    overall: { total: results.length, answeredUnsupported: results.filter((result) => result.answered === 'unsupported').length, blocked: results.filter((result) => result.answered === 'blocked').length },
    byFamily: [...families].sort(([left], [right]) => left.localeCompare(right)).map(([family, group]) => ({ family, ...group })),
    byTemplate: [...templates].sort(([left], [right]) => left.localeCompare(right)).map(([template, group]) => ({ template, ...group })),
    questions: results.map((result) => ({ id: result.id, verdict: result.verdict, fields: [...result.fields] })),
  };
}

export function groupLines(report: Report): readonly string[] {
  return [
    `answered unsupported: ${report.overall.answeredUnsupported} of ${report.overall.total}`,
    ...report.byFamily.map((group) => `family ${group.family}: refused ${group.refused}, wrongly planned ${group.wronglyPlanned}, other ${group.other}`),
    ...report.byTemplate.map((group) => `template ${group.template}: right ${group.right}, wrong ${group.wrong}, refused ${group.refused}`),
  ];
}
