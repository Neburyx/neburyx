import { z } from 'zod';

const featureAvailabilitySchema = z.strictObject({ available: z.boolean() });

/** Which AI features can be used now: a provider is configured, the feature is on and what it needs is in place. */
const assistantAvailabilitySchema = z.union([
  z.strictObject({ available: z.literal(false) }),
  /** `messageWords` is the effective limit of a message, so the panel counts against the server's own figure; `model` is the name the operator configured for the Assistant. */
  z.strictObject({ available: z.literal(true), messageWords: z.number().int().positive(), model: z.string().min(1) }),
]);

export const aiStatusResponseSchema = z.strictObject({ ask: featureAvailabilitySchema, summary: featureAvailabilitySchema, assistant: assistantAvailabilitySchema });

export type AiStatusResponse = z.infer<typeof aiStatusResponseSchema>;

export const AI_PROVIDERS = ['anthropic'] as const;

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AiEffort = (typeof AI_EFFORTS)[number];

export const AI_CACHE_TTLS = ['5m', '1h'] as const;

export type AiCacheTtl = (typeof AI_CACHE_TTLS)[number];

/** Hypotheses: they are what the AI settings use when the file does not say, and they are expected to change with measurement. */
export const AI_DEFAULTS = {
  timeoutMs: 60_000,
  maxRetries: 0,
  maxTokens: 8_192,
  effort: 'medium' satisfies AiEffort,
  cache: { enabled: true, ttl: '5m' satisfies AiCacheTtl },
} as const;

/** What the case summary uses when its settings do not say. */
export const SUMMARY_DEFAULTS = {
  model: 'claude-sonnet-5-5',
  timeoutMs: AI_DEFAULTS.timeoutMs,
  totalTimeoutMs: 180_000,
  maxCalls: 5,
  maxElements: 300,
  /** The most output tokens of a model call, its reasoning included. */
  maxOutputTokens: 4000,
  /**
   * The size guard on the text sent to the model, in tokens as the summarizer estimates them: measured on 300 elements, the larger of bare ones and ones with a few short properties (about 20,200 estimated),
   * times 1.2, rounded up. Operators whose elements carry long text properties raise `NEBURYX_SUMMARY_MAX_INPUT_TOKENS` (136,000 admits the heavy sample of the evaluation); see `tools/summary-suite/README.md`.
   */
  maxInputTokens: 25_000,
  retentionDays: 30,
} as const;

export const AI_LIMITS = {
  timeoutMs: { min: 1_000, max: 600_000 },
  maxRetries: { min: 0, max: 5 },
  maxTokens: { min: 1, max: 32_768 },
} as const;

/** The variables that took the place of the keys the mapping file once held for Ask, by the key's name. */
export const AI_MOVED_KEYS: Readonly<Record<string, string>> = {
  provider: 'NEBURYX_ASK_PROVIDER',
  model: 'NEBURYX_ASK_CLASSIFICATION_MODEL',
  key: 'NEBURYX_ASK_API_KEY or NEBURYX_ASK_API_KEY_FILE',
  effort: 'NEBURYX_ASK_EFFORT',
  timeout_ms: 'NEBURYX_ASK_TIMEOUT_MS',
  max_retries: 'NEBURYX_ASK_MAX_RETRIES',
  max_tokens: 'NEBURYX_ASK_MAX_TOKENS',
  cache: 'NEBURYX_AI_CACHE and NEBURYX_AI_CACHE_TTL',
};

function unrecognizedKeys(keys: readonly string[]): string {
  return keys
    .map((key) => {
      const moved = AI_MOVED_KEYS[key];
      return moved === undefined ? `ai.${key} is not a setting` : `ai.${key} is no longer set in the mapping file; set ${moved} in the environment`;
    })
    .join('; ');
}

/** The mapping file's `ai` block holds the preview switch only; everything else about Ask is in the environment. */
export const aiSettingsSchema = z.strictObject(
  { preview: z.boolean().optional() },
  { error: (issue) => (issue.code === 'unrecognized_keys' ? unrecognizedKeys(issue.keys) : undefined) },
);

export type AiSettings = z.infer<typeof aiSettingsSchema>;
