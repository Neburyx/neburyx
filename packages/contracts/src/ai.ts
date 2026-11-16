import { z } from 'zod';

export const aiStatusResponseSchema = z.strictObject({ preview: z.literal(true) });

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

/** What the case summary uses when its settings do not say; the size guard has no default until a measured run sets one. */
export const SUMMARY_DEFAULTS = {
  model: 'claude-sonnet-5-5',
  timeoutMs: AI_DEFAULTS.timeoutMs,
  totalTimeoutMs: 180_000,
  maxCalls: 5,
  maxElements: 300,
  /** The most output tokens of a model call, the reasoning of the model included; 2,000 cut a 300-element view short on Opus in the first measured run. */
  maxOutputTokens: 4000,
  /**
   * The size guard on the text sent to the model, in tokens, estimated with `BYTES_PER_TOKEN_ESTIMATE` of the summarizer. Set from the first measured runs (2026-11-15; Sonnet and Opus count the same): a view of 300
   * elements (the element cap) of bare elements (type, title, id) is 11,961 tokens and one whose elements carry four short properties and a relationship property is 18,598 tokens, the larger times 1.2 and rounded up
   * to the next 1,000 is 23,000. Elements with long text properties are larger (eight sentence-long properties on each of 300 elements is 84,606 tokens, a guard of 102,000, the documented upper bound): an operator
   * whose data looks like that raises `NEBURYX_SUMMARY_MAX_INPUT_TOKENS`.
   */
  maxInputTokens: 23_000,
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
