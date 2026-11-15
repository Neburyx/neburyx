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
