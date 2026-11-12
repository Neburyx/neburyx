import type { PromptRegistry } from '../prompts.js';
import type { FailureCode, ModelAnswer, ModelProvider, ModelRequest, TokenUsage } from '../provider.js';

export type FixtureReply =
  | { readonly kind: 'ok'; readonly text: string; readonly usage?: TokenUsage; readonly model?: string }
  | { readonly kind: 'refused'; readonly usage?: TokenUsage }
  | { readonly kind: 'failed'; readonly code: FailureCode; readonly usage?: TokenUsage };

export type FixtureReplySource = FixtureReply | ((request: ModelRequest) => FixtureReply);

export type FixtureReplies = Readonly<Record<string, FixtureReplySource>>;

export const DEFAULT_FIXTURE_MODEL = 'fixture-model';

const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };

export class MissingFixtureReplyError extends Error {}

export interface FixtureProvider extends ModelProvider {
  readonly calls: readonly ModelRequest[];
}

export interface FixtureOptions {
  readonly registry: PromptRegistry;
  readonly replies: FixtureReplies;
  readonly model?: string;
}

export function replyKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function createFixtureProvider(options: FixtureOptions): FixtureProvider {
  const calls: ModelRequest[] = [];
  const model = options.model ?? DEFAULT_FIXTURE_MODEL;
  return {
    calls,
    async complete(request): Promise<ModelAnswer> {
      const { record } = options.registry.resolve(request.promptId, request.parameters);
      calls.push(request);
      const key = replyKey(record.id, record.version);
      const source = options.replies[key];
      if (source === undefined) throw new MissingFixtureReplyError(`the fixture has no reply for ${key}`);
      const reply = typeof source === 'function' ? source(request) : source;
      switch (reply.kind) {
        case 'ok':
          return { status: 'ok', text: reply.text, usage: reply.usage ?? UNKNOWN_USAGE, model: reply.model ?? model, prompt: record };
        case 'refused':
          return { status: 'refused', usage: reply.usage ?? UNKNOWN_USAGE, prompt: record };
        case 'failed':
          return { status: 'failed', code: reply.code, usage: reply.usage ?? UNKNOWN_USAGE, prompt: record };
        default: {
          const unreachable: never = reply;
          return unreachable;
        }
      }
    },
  };
}
