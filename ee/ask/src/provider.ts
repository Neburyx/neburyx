export const PROMPT_IDS = ['ask.plan', 'summary.view', 'assistant.route'] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

export type PromptParameters = Readonly<Record<string, string | number>>;

export interface ModelRequest {
  readonly promptId: PromptId;
  readonly parameters: PromptParameters;
}

export type PromptSource = 'builtin' | 'override';

export interface PromptRecord {
  readonly id: PromptId;
  readonly version: number;
  readonly source: PromptSource;
  readonly sha256: string;
}

export type TokenUsage = { readonly kind: 'known'; readonly inputTokens: number; readonly outputTokens: number } | { readonly kind: 'unknown' };

export const FAILURE_CODES = ['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const;

/** `rejected` is a credential the service refused (401, 403) or one that could not be read; `provider-error` is a 5xx or any other failure of the service; `truncated` is a reply cut off at the token limit. */
export type FailureCode = (typeof FAILURE_CODES)[number];

export type ModelAnswer =
  | { readonly status: 'ok'; readonly text: string; readonly usage: TokenUsage; readonly model: string; readonly prompt: PromptRecord }
  | { readonly status: 'refused'; readonly usage: TokenUsage; readonly prompt: PromptRecord }
  | { readonly status: 'failed'; readonly code: FailureCode; readonly prompt: PromptRecord };

export interface ModelProvider {
  readonly complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelAnswer>;
}
