import { z } from 'zod';
import { codePoints } from './investigations.js';
import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema } from './template-run.js';

/** The longest question the plan endpoint takes, in characters. */
export const ASK_MESSAGE_MAX_LENGTH = 1000;
/** The longest rationale or reason a plan carries, in characters. */
export const ASK_TEXT_MAX_LENGTH = 500;

const askText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => codePoints(value) <= max, { message: `at most ${max} characters` })
    .meta({ maxLength: max });

export const askPlanRequestSchema = z.strictObject({ message: askText(ASK_MESSAGE_MAX_LENGTH) });

const planShape = { kind: z.literal('plan'), templateVersion: z.number().int().min(1), rationale: askText(ASK_TEXT_MAX_LENGTH) };

/** What a planner answers: a template of the catalog with its typed parameters, or `unsupported`. Nothing in it is query text. */
export const askPlanSchema = z.union([
  z.strictObject({ ...planShape, templateId: z.literal('shared-attribute'), params: sharedAttributeParamsSchema }),
  z.strictObject({ ...planShape, templateId: z.literal('linked-entities'), params: linkedEntitiesParamsSchema }),
  z.strictObject({ kind: z.literal('unsupported'), reason: askText(ASK_TEXT_MAX_LENGTH) }),
]);

export const askPlanResponseSchema = z.strictObject({ plan: askPlanSchema });

export const askRunRequestSchema = z.strictObject({ planId: z.uuid() });

export const ASK_RUN_OUTCOMES = ['complete', 'partial', 'failed'] as const;

export const askRunResponseSchema = z.strictObject({ planId: z.uuid(), outcome: z.enum(ASK_RUN_OUTCOMES) });

export type AskPlan = z.infer<typeof askPlanSchema>;
export type AskPlanRequest = z.infer<typeof askPlanRequestSchema>;
export type AskRunRequest = z.infer<typeof askRunRequestSchema>;

export type AskAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** The seam Ask plans through: the Community default says it is not available; an installed planner answers a plan for the text it is given. */
export interface AskPlanner {
  availability(): AskAvailability;
  plan(input: { readonly text: string }): Promise<AskPlan>;
}
