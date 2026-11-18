import { AI_LIMITS, SUMMARY_DEFAULTS } from '@neburyx/contracts';
import { given, integerChoice, type Env } from '@neburyx/ee-ai-runtime';

export const ASSISTANT_VARIABLES = {
  model: 'NEBURYX_ASSISTANT_MODEL',
  timeoutMs: 'NEBURYX_ASSISTANT_TIMEOUT_MS',
  totalTimeoutMs: 'NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS',
  maxCalls: 'NEBURYX_ASSISTANT_MAX_CALLS',
  maxSteps: 'NEBURYX_ASSISTANT_MAX_STEPS',
  maxRows: 'NEBURYX_ASSISTANT_MAX_ROWS',
  contextTurns: 'NEBURYX_ASSISTANT_CONTEXT_TURNS',
  maxMessageWords: 'NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS',
  maxInputTokens: 'NEBURYX_ASSISTANT_MAX_INPUT_TOKENS',
  maxOutputTokens: 'NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS',
  runRetentionDays: 'NEBURYX_ASSISTANT_RUN_RETENTION_DAYS',
} as const;

/** Defaults and ceilings are hypotheses to be measured, except the timeout of a call, the calls, the words of a message and the turns of context, which are given. */
const DEFAULTS = {
  model: SUMMARY_DEFAULTS.model,
  timeoutMs: 60_000,
  totalTimeoutMs: SUMMARY_DEFAULTS.totalTimeoutMs,
  maxCalls: 5,
  maxSteps: 4,
  contextTurns: 3,
  maxMessageWords: 1000,
  maxInputTokens: SUMMARY_DEFAULTS.maxInputTokens,
  maxOutputTokens: SUMMARY_DEFAULTS.maxOutputTokens,
  runRetentionDays: SUMMARY_DEFAULTS.retentionDays,
} as const;

const RANGES = {
  timeoutMs: AI_LIMITS.timeoutMs,
  totalTimeoutMs: AI_LIMITS.timeoutMs,
  maxCalls: { min: 1, max: 10 },
  maxSteps: { min: 1, max: 8 },
  contextTurns: { min: 1, max: 6 },
  maxMessageWords: { min: 1, max: 3000 },
  maxInputTokens: { min: 1, max: 100_000 },
  maxOutputTokens: { min: 1, max: 32_000 },
} as const;

export interface AssistantSettings {
  readonly model: string;
  /** One model call. */
  readonly timeoutMs: number;
  /** A whole turn. */
  readonly totalTimeoutMs: number;
  /** Model calls a turn. */
  readonly maxCalls: number;
  /** Reads (tool steps) a turn. */
  readonly maxSteps: number;
  /** Rows read a turn, lowered by the operator; absent, the bound is the source's own `max_page` times the steps. */
  readonly maxRows?: number;
  readonly contextTurns: number;
  readonly maxMessageWords: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** How many days the stored records of the turns' model calls are kept. */
  readonly runRetentionDays: number;
}

export type AssistantSettingsRead = { readonly ok: true; readonly settings: AssistantSettings } | { readonly ok: false; readonly problems: readonly string[] };

function wholeNumber(env: Env, name: string, range: { readonly min: number; readonly max: number }, fallback: number, problems: string[]): number {
  return integerChoice(env, name, range, fallback, problems);
}

function positiveWholeNumber(env: Env, name: string, fallback: number, problems: string[]): number {
  const value = given(env, name);
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    problems.push(`${name} must be a positive whole number`);
    return fallback;
  }
  return parsed;
}

/** Reads the assistant's settings from the environment; a problem names the variable and the accepted range, never the value. The result is frozen. */
export function readAssistantSettings(env: Env): AssistantSettingsRead {
  const problems: string[] = [];
  const model = given(env, ASSISTANT_VARIABLES.model) ?? DEFAULTS.model;
  const timeoutMs = wholeNumber(env, ASSISTANT_VARIABLES.timeoutMs, RANGES.timeoutMs, DEFAULTS.timeoutMs, problems);
  const totalTimeoutMs = wholeNumber(env, ASSISTANT_VARIABLES.totalTimeoutMs, RANGES.totalTimeoutMs, DEFAULTS.totalTimeoutMs, problems);
  const maxCalls = wholeNumber(env, ASSISTANT_VARIABLES.maxCalls, RANGES.maxCalls, DEFAULTS.maxCalls, problems);
  const maxSteps = wholeNumber(env, ASSISTANT_VARIABLES.maxSteps, RANGES.maxSteps, DEFAULTS.maxSteps, problems);
  const contextTurns = wholeNumber(env, ASSISTANT_VARIABLES.contextTurns, RANGES.contextTurns, DEFAULTS.contextTurns, problems);
  const maxMessageWords = wholeNumber(env, ASSISTANT_VARIABLES.maxMessageWords, RANGES.maxMessageWords, DEFAULTS.maxMessageWords, problems);
  const maxInputTokens = wholeNumber(env, ASSISTANT_VARIABLES.maxInputTokens, RANGES.maxInputTokens, DEFAULTS.maxInputTokens, problems);
  const maxOutputTokens = wholeNumber(env, ASSISTANT_VARIABLES.maxOutputTokens, RANGES.maxOutputTokens, DEFAULTS.maxOutputTokens, problems);
  const runRetentionDays = positiveWholeNumber(env, ASSISTANT_VARIABLES.runRetentionDays, DEFAULTS.runRetentionDays, problems);
  const rows = given(env, ASSISTANT_VARIABLES.maxRows);
  const maxRows = rows === undefined ? undefined : /^\d+$/.test(rows) && Number(rows) >= 1 && Number.isSafeInteger(Number(rows)) ? Number(rows) : undefined;
  if (rows !== undefined && maxRows === undefined) problems.push(`${ASSISTANT_VARIABLES.maxRows} must be a positive whole number`);
  if (timeoutMs > totalTimeoutMs) problems.push(`${ASSISTANT_VARIABLES.timeoutMs} must not be above ${ASSISTANT_VARIABLES.totalTimeoutMs}`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, settings: Object.freeze({ model, timeoutMs, totalTimeoutMs, maxCalls, maxSteps, ...(maxRows === undefined ? {} : { maxRows }), contextTurns, maxMessageWords, maxInputTokens, maxOutputTokens, runRetentionDays }) };
}

/** The rows a turn may read from a source: the source's own page limit times the steps, or less when the operator set a lower figure. */
export function rowsAllowed(settings: AssistantSettings, maxPage: number): number {
  const bound = maxPage * settings.maxSteps;
  return settings.maxRows === undefined ? bound : Math.min(bound, settings.maxRows);
}
