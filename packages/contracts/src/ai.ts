import { z } from 'zod';

export const aiStatusResponseSchema = z.strictObject({ preview: z.literal(true) });

export type AiStatusResponse = z.infer<typeof aiStatusResponseSchema>;

export const AI_PROVIDERS = ['anthropic'] as const;

/** Hypotheses: they are what the AI settings use when the file does not say, and they are expected to change with measurement. */
export const AI_DEFAULTS = { timeoutMs: 60_000, maxRetries: 0, maxTokens: 8_192 } as const;

export const AI_LIMITS = {
  timeoutMs: { min: 1_000, max: 600_000 },
  maxRetries: { min: 0, max: 5 },
  maxTokens: { min: 1, max: 32_768 },
} as const;

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const absolutePathSchema = z.string().min(1).startsWith('/');

const aiKeySchema = z
  .strictObject({ env: z.string().regex(ENVIRONMENT_VARIABLE_NAME).optional(), file: absolutePathSchema.optional() })
  .refine((key) => (key.env === undefined) !== (key.file === undefined), { message: 'give exactly one of env and file' });

function limitedInteger(limits: { readonly min: number; readonly max: number }) {
  return z.number().int().min(limits.min).max(limits.max);
}

const aiPropertyListSchema = z
  .array(z.string().min(1, { message: 'a property name is empty' }))
  .min(1, { message: 'the list is empty' })
  .refine((names) => new Set(names).size === names.length, { message: 'a property is listed twice' });

export const AI_ALL_PROPERTIES = '*';

export const aiSettingsSchema = z.strictObject({
  preview: z.boolean().optional(),
  provider: z.enum(AI_PROVIDERS).optional(),
  model: z.string().min(1).optional(),
  key: aiKeySchema.optional(),
  prompts: z.record(z.string().min(1), absolutePathSchema).optional(),
  timeout_ms: limitedInteger(AI_LIMITS.timeoutMs).optional(),
  max_retries: limitedInteger(AI_LIMITS.maxRetries).optional(),
  max_tokens: limitedInteger(AI_LIMITS.maxTokens).optional(),
  properties: z.record(z.string().min(1, { message: 'the key is empty' }), aiPropertyListSchema).optional(),
  pii_override: z.boolean().optional(),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;
