import { AI_LIMITS, SUMMARY_DEFAULTS } from '@neburyx/contracts';
import { given, integerChoice, type Env } from '@neburyx/ee-ai-runtime';
import { TOKEN_KEY_VARIABLES } from './token-keys.js';

export const SUMMARY_VARIABLES = {
  model: 'NEBURYX_SUMMARY_MODEL',
  timeoutMs: 'NEBURYX_SUMMARY_TIMEOUT_MS',
  totalTimeoutMs: 'NEBURYX_SUMMARY_TOTAL_TIMEOUT_MS',
  maxCalls: 'NEBURYX_SUMMARY_MAX_CALLS',
  maxElements: 'NEBURYX_SUMMARY_MAX_ELEMENTS',
  maxOutputTokens: 'NEBURYX_SUMMARY_MAX_OUTPUT_TOKENS',
  maxInputTokens: 'NEBURYX_SUMMARY_MAX_INPUT_TOKENS',
  retentionDays: 'NEBURYX_SUMMARY_RUN_RETENTION_DAYS',
} as const;

/** The output limit of a call: from enough for twelve sentences to within the range Ask accepts. */
const OUTPUT_TOKEN_LIMITS = { min: 1000, max: 32_000 } as const;

export interface SummarySettings {
  readonly model: string;
  readonly timeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxCalls: number;
  readonly maxElements: number;
  /** The most output tokens of a call, the model's reasoning included. */
  readonly maxOutputTokens: number;
  /** The size guard on the text sent, in estimated tokens. */
  readonly maxInputTokens: number;
  readonly retentionDays: number;
}

export type SummarySettingsRead = { readonly ok: true; readonly settings: SummarySettings } | { readonly ok: false; readonly problems: readonly string[] };

function positiveWholeNumber(env: Env, name: string, fallback: number | undefined, problems: string[]): number | undefined {
  const value = given(env, name);
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    problems.push(`${name} must be a positive whole number`);
    return fallback;
  }
  return parsed;
}

/** Reads the summary settings from the environment; a problem names the variable and the accepted form, never the value. */
export function readSummarySettings(env: Env): SummarySettingsRead {
  const problems: string[] = [];
  const model = given(env, SUMMARY_VARIABLES.model) ?? SUMMARY_DEFAULTS.model;
  const timeoutMs = integerChoice(env, SUMMARY_VARIABLES.timeoutMs, AI_LIMITS.timeoutMs, SUMMARY_DEFAULTS.timeoutMs, problems);
  const totalTimeoutMs = integerChoice(env, SUMMARY_VARIABLES.totalTimeoutMs, AI_LIMITS.timeoutMs, SUMMARY_DEFAULTS.totalTimeoutMs, problems);
  const maxCalls = positiveWholeNumber(env, SUMMARY_VARIABLES.maxCalls, SUMMARY_DEFAULTS.maxCalls, problems) ?? SUMMARY_DEFAULTS.maxCalls;
  const maxElements = positiveWholeNumber(env, SUMMARY_VARIABLES.maxElements, SUMMARY_DEFAULTS.maxElements, problems) ?? SUMMARY_DEFAULTS.maxElements;
  const maxOutputTokens = integerChoice(env, SUMMARY_VARIABLES.maxOutputTokens, OUTPUT_TOKEN_LIMITS, SUMMARY_DEFAULTS.maxOutputTokens, problems);
  const maxInputTokens = positiveWholeNumber(env, SUMMARY_VARIABLES.maxInputTokens, SUMMARY_DEFAULTS.maxInputTokens, problems) ?? SUMMARY_DEFAULTS.maxInputTokens;
  const retentionDays = positiveWholeNumber(env, SUMMARY_VARIABLES.retentionDays, SUMMARY_DEFAULTS.retentionDays, problems) ?? SUMMARY_DEFAULTS.retentionDays;
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, settings: { model, timeoutMs, totalTimeoutMs, maxCalls, maxElements, maxOutputTokens, maxInputTokens, retentionDays } };
}

export type SummaryAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** The summary is available when Ask is configured, its settings are read and the token key is set. */
export function summaryAvailability(state: { readonly askConfigured: boolean; readonly settings: SummarySettings | undefined; readonly tokenKeyConfigured: boolean }): SummaryAvailability {
  if (!state.askConfigured || state.settings === undefined) return { available: false, reason: 'the AI preview is not configured' };
  if (!state.tokenKeyConfigured) return { available: false, reason: `${TOKEN_KEY_VARIABLES.current} is not set` };
  return { available: true };
}
