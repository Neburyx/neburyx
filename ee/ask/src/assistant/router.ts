import { ASK_SAVED_PATTERN_NOTE, readAssistantRoute, type AskFolder, type AssistantRouterReply } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type FailureCode } from '@neburyx/ee-ai-runtime';
import { estimateTokens } from '../case-summary/assemble.js';
import { noteModelAnswer, noteModelCall } from './turn-audit.js';
import { buildAssistantInstructions, type AssistantInstructions } from './instructions.js';

export const ROUTER_PROMPT_ID = 'assistant.route';
export const ROUTER_PROMPT_VERSION = 1;
export const ROUTER_AUDIT_ACTION = 'assistant.route';

const NO_KEYS = '(none)';

export interface RouterOptions {
  readonly model: AuditedModelCall;
  readonly folder: () => AskFolder | undefined;
  readonly instructions: () => AssistantInstructions | undefined;
  readonly maxInputTokens: () => number;
}

export interface RouterInput {
  readonly sourceId: string;
  readonly investigationId: string;
  readonly message: string;
  readonly viewElementKeys: readonly string[];
  readonly actorId: string;
  readonly actorRole: Parameters<AuditedModelCall['call']>[1]['actorRole'];
  readonly traceId: string;
  readonly patternCatalog?: string;
}

export type RouterOutcome =
  | { readonly status: 'routed'; readonly reply: AssistantRouterReply }
  | { readonly status: 'unplaced' }
  | { readonly status: 'too-large' }
  | { readonly status: 'failed'; readonly code: FailureCode | 'refused' };

/** What the call is given besides the instructions: the message as typed, the keys of the view and, with a catalog, the note and the catalog of the caller's own saved patterns. */
const valuesOf = (input: RouterInput): string =>
  [`Message:\n${input.message}`, `Keys of the elements in view:\n${input.viewElementKeys.length === 0 ? NO_KEYS : input.viewElementKeys.join('\n')}`, ...(input.patternCatalog === undefined ? [] : [`${ASK_SAVED_PATTERN_NOTE}\n${input.patternCatalog}`])].join('\n\n');

/**
 * One audited call of the router, with the router's prompt and the source's `classification.md` as the instructions (so the audit's instructions hash covers both) and the message as typed in the values.
 * The reply is read strictly; whatever does not fit is `unplaced` and there is no second call.
 */
export function createAssistantRouter(options: RouterOptions): (input: RouterInput, signal: AbortSignal) => Promise<RouterOutcome> {
  return async (input, signal) => {
    const base = options.instructions();
    if (base === undefined) return { status: 'failed', code: 'rejected' };
    const source = options.folder()?.source(input.sourceId);
    const instructions = source === undefined ? base : buildAssistantInstructions(`${base.prompt}\n\n# This source's questions\n\n${source.classification.text}`);
    const values = valuesOf(input);
    if (estimateTokens(instructions.text, values) > options.maxInputTokens()) return { status: 'too-large' };
    let answer;
    noteModelCall({ modelRef: options.model.modelRef, promptId: ROUTER_PROMPT_ID, promptVersion: ROUTER_PROMPT_VERSION, instructionsSha256: instructions.sha256 });
    try {
      answer = await options.model.call(
        { promptId: ROUTER_PROMPT_ID, version: ROUTER_PROMPT_VERSION, instructions: instructions.text, values },
        { action: ROUTER_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, sourceId: input.sourceId, investigationId: input.investigationId },
        signal,
      );
    } catch (error) {
      // an event that cannot be built withholds the answer; any other failure of the call is the service's
      if (error instanceof AuditUnavailableError) throw error;
      return { status: 'failed', code: 'unreachable' };
    }
    noteModelAnswer({ ...(answer.status === 'ok' ? { model: answer.model } : {}), ...(answer.usage === undefined ? {} : { usage: answer.usage }) });
    if (answer.status === 'refused') return { status: 'failed', code: 'refused' };
    if (answer.status === 'failed') return { status: 'failed', code: answer.code };
    const read = readAssistantRoute(answer.text);
    return read.ok ? { status: 'routed', reply: read.reply } : { status: 'unplaced' };
  };
}
