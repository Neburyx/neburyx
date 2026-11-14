import { createHash } from 'node:crypto';

/** What a caller sends: the prompt as it wrote it. `instructions` are the fixed part (the one cached block); `values` follow it and hold what changes with each call. */
export interface ModelRequest {
  readonly promptId: string;
  readonly version: number;
  readonly instructions?: string;
  readonly values: string;
}

/** Which prompt a call used: its id and version, and the SHA-256 of its fixed instructions (of nothing when there are none), never of the values. */
export interface PromptRecord {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
}

export function promptRecordOf(request: ModelRequest): PromptRecord {
  return { id: request.promptId, version: request.version, sha256: createHash('sha256').update(request.instructions ?? '', 'utf8').digest('hex') };
}

/** `inputTokens` is what the provider counts after the last cache breakpoint; a cache count the provider did not state is absent, never zero. */
export type TokenUsage =
  | { readonly kind: 'known'; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
  | { readonly kind: 'unknown' };

export const FAILURE_CODES = ['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'] as const;

/** `rejected` is a credential the service refused (401, 403) or one that could not be read; `provider-error` is a 5xx or any other failure of the service; `truncated` is a reply cut off at the token limit. */
export type FailureCode = (typeof FAILURE_CODES)[number];

export type ModelAnswer =
  | { readonly status: 'ok'; readonly text: string; readonly usage: TokenUsage; readonly model: string; readonly prompt: PromptRecord }
  | { readonly status: 'refused'; readonly usage: TokenUsage; readonly prompt: PromptRecord }
  | { readonly status: 'failed'; readonly code: FailureCode; readonly usage?: TokenUsage; readonly prompt: PromptRecord };

export interface ModelProvider {
  readonly complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelAnswer>;
}
