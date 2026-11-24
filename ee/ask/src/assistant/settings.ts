import { AI_LIMITS, SUMMARY_DEFAULTS, THREAD_READ_TURNS_CEILING, THREAD_READ_TURNS_DEFAULT } from '@neburyx/contracts';
import { given, integerChoice, type Env } from '@neburyx/ee-ai-runtime';

export const ASSISTANT_VARIABLES = {
  model: 'NEBURYX_ASSISTANT_MODEL',
  timeoutMs: 'NEBURYX_ASSISTANT_TIMEOUT_MS',
  totalTimeoutMs: 'NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS',
  maxCalls: 'NEBURYX_ASSISTANT_MAX_CALLS',
  maxSteps: 'NEBURYX_ASSISTANT_MAX_STEPS',
  maxRows: 'NEBURYX_ASSISTANT_MAX_ROWS',
  contextTurns: 'NEBURYX_ASSISTANT_CONTEXT_TURNS',
  contextText: 'NEBURYX_ASSISTANT_CONTEXT_TEXT',
  maxMessageWords: 'NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS',
  maxInputTokens: 'NEBURYX_ASSISTANT_MAX_INPUT_TOKENS',
  maxOutputTokens: 'NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS',
  runRetentionDays: 'NEBURYX_ASSISTANT_RUN_RETENTION_DAYS',
  threadRetention: 'NEBURYX_ASSISTANT_THREAD_RETENTION',
  threadReadTurns: 'NEBURYX_ASSISTANT_THREAD_READ_TURNS',
} as const;

/** Defaults and ceilings are hypotheses to be measured, except the timeout of a call, the words of a message and the turns of context, which are given, and the calls and the input tokens of a call, which were measured. */
export const DEFAULTS = {
  model: SUMMARY_DEFAULTS.model,
  timeoutMs: 60_000,
  totalTimeoutMs: SUMMARY_DEFAULTS.totalTimeoutMs,
  // 7: the trial's 72 agent turns took at most 6 calls with the acknowledging call (95th percentile 5) and at most 5 without it (which the product now drops after an answer the checks accept whole); plus the router's one or two calls. A turn whose last answer still loses a sentence keeps that call and may need 8; the ceiling stays 10
  maxCalls: 7,
  maxSteps: 4,
  contextTurns: 3,
  maxMessageWords: 1000,
  // 45,000 estimated tokens (the estimate counts about 1.6 times what the provider reports): about a third above the largest call measured on a 12-turn thread, about 20,500 provider tokens or 34,000 estimated.
  maxInputTokens: 45_000,
  maxOutputTokens: SUMMARY_DEFAULTS.maxOutputTokens,
  runRetentionDays: SUMMARY_DEFAULTS.retentionDays,
} as const;

export const RANGES = {
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
  /** Whether the loop is also given the earlier turns' question and answer text, as the thread read presents it under this message's mask. Off unless the operator turns it on. */
  readonly contextText: boolean;
  readonly maxMessageWords: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** How many days the stored records of the turns' model calls are kept. */
  readonly runRetentionDays: number;
  /** When a thread is cleared: `close`, when its investigation is closed, archived or deleted. The only value there is; keeping a thread longer, with or without text, is later. */
  readonly threadRetention: 'close';
  /** How many of the most recent turns of a thread one read gives; nothing stored is trimmed. */
  readonly threadReadTurns: number;
}

export type AssistantSettingsRead = { readonly ok: true; readonly settings: AssistantSettings } | { readonly ok: false; readonly problems: readonly string[] };

function wholeNumber(env: Env, name: string, range: { readonly min: number; readonly max: number }, fallback: number, problems: string[]): number {
  return integerChoice(env, name, range, fallback, problems);
}

/** A switch that is off unless it is `true`; any other value that is not `false` is a problem, which names the variable and never the value. */
function switchOf(env: Env, name: string, problems: string[]): boolean {
  const value = given(env, name);
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  problems.push(`${name} must be true or false`);
  return false;
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
  const contextText = switchOf(env, ASSISTANT_VARIABLES.contextText, problems);
  const maxMessageWords = wholeNumber(env, ASSISTANT_VARIABLES.maxMessageWords, RANGES.maxMessageWords, DEFAULTS.maxMessageWords, problems);
  const maxInputTokens = wholeNumber(env, ASSISTANT_VARIABLES.maxInputTokens, RANGES.maxInputTokens, DEFAULTS.maxInputTokens, problems);
  const maxOutputTokens = wholeNumber(env, ASSISTANT_VARIABLES.maxOutputTokens, RANGES.maxOutputTokens, DEFAULTS.maxOutputTokens, problems);
  const runRetentionDays = positiveWholeNumber(env, ASSISTANT_VARIABLES.runRetentionDays, DEFAULTS.runRetentionDays, problems);
  const threadReadTurns = wholeNumber(env, ASSISTANT_VARIABLES.threadReadTurns, { min: 1, max: THREAD_READ_TURNS_CEILING }, THREAD_READ_TURNS_DEFAULT, problems);
  const retention = given(env, ASSISTANT_VARIABLES.threadRetention);
  if (retention !== undefined && retention !== 'close') problems.push(`${ASSISTANT_VARIABLES.threadRetention} must be close`);
  const rows = given(env, ASSISTANT_VARIABLES.maxRows);
  const maxRows = rows === undefined ? undefined : /^\d+$/.test(rows) && Number(rows) >= 1 && Number.isSafeInteger(Number(rows)) ? Number(rows) : undefined;
  if (rows !== undefined && maxRows === undefined) problems.push(`${ASSISTANT_VARIABLES.maxRows} must be a positive whole number`);
  if (timeoutMs > totalTimeoutMs) problems.push(`${ASSISTANT_VARIABLES.timeoutMs} must not be above ${ASSISTANT_VARIABLES.totalTimeoutMs}`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, settings: Object.freeze({ model, timeoutMs, totalTimeoutMs, maxCalls, maxSteps, ...(maxRows === undefined ? {} : { maxRows }), contextTurns, contextText, maxMessageWords, maxInputTokens, maxOutputTokens, runRetentionDays, threadRetention: 'close' as const, threadReadTurns }) };
}

/** The rows a turn may read from a source: the source's own page limit times the steps, or less when the operator set a lower figure. */
export function rowsAllowed(settings: AssistantSettings, maxPage: number): number {
  const bound = maxPage * settings.maxSteps;
  return settings.maxRows === undefined ? bound : Math.min(bound, settings.maxRows);
}
