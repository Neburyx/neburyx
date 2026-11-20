import { ASK_SAVED_PATTERN_NOTE, readAssistantRoute, type AskFolder, type AssistantRouterReply } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type FailureCode } from '@neburyx/ee-ai-runtime';
import { estimateTokens } from '../case-summary/assemble.js';
import { noteModelAnswer, startModelCall } from './turn-audit.js';
import { buildAssistantInstructions, type AssistantInstructions } from './instructions.js';

export const ROUTER_PROMPT_ID = 'assistant.route';
export const ROUTER_PROMPT_VERSION = 2;
export const ROUTER_AUDIT_ACTION = 'assistant.route';

const NO_KEYS = '(none)';
const NOT_A_ROUTE_NOTE = 'Your last reply was not a route. Reply with one route object only: start with { and write nothing before or after it, no reasoning.';
const REPEATS = 1;

export interface RouterOptions {
  readonly model: AuditedModelCall;
  readonly folder: () => AskFolder | undefined;
  readonly instructions: () => AssistantInstructions | undefined;
  readonly maxInputTokens: () => number;
  /** The calls of a whole turn; the router repeats a reply that is not a route only when it leaves room for the answer too. */
  readonly maxCalls?: () => number;
  /** Whether a message that needs several reads is placed on its first read (the tool loop is on); otherwise such a message is not placed. */
  readonly multiRead?: () => boolean;
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
  /** The earlier turns of this person's thread as the router is shown them, with the elements they name by key; absent when there is none. */
  readonly context?: string;
  /** Whether a reply that was read fits this turn; one that does not is treated as a reply that is not a route. */
  readonly accepts?: (reply: AssistantRouterReply) => boolean;
}

export type RouterOutcome =
  | { readonly status: 'routed'; readonly reply: AssistantRouterReply; readonly calls: number }
  | { readonly status: 'unplaced'; readonly calls: number }
  | { readonly status: 'too-large' }
  | { readonly status: 'failed'; readonly code: FailureCode | 'refused' };

/** What the call is given besides the instructions: the message as typed, the context of the thread, the keys of the view and, with a catalog, the note and the catalog of the caller's own saved patterns. */
const valuesOf = (input: RouterInput): string =>
  [`Message:\n${input.message}`, ...(input.context === undefined ? [] : [input.context]), `Keys of the elements in view:\n${input.viewElementKeys.length === 0 ? NO_KEYS : input.viewElementKeys.join('\n')}`, ...(input.patternCatalog === undefined ? [] : [`${ASK_SAVED_PATTERN_NOTE}\n${input.patternCatalog}`])].join('\n\n');

/**
 * One audited call of the router, with the router's prompt and the source's `classification.md` as the instructions (so the audit's instructions hash covers both) and the message as typed in the values.
 * The reply is read strictly; a reply that is not a route is asked for once more with a fixed note, and a second one is `unplaced`.
 */
export function createAssistantRouter(options: RouterOptions): (input: RouterInput, signal: AbortSignal) => Promise<RouterOutcome> {
  return async (input, signal) => {
    const base = options.instructions();
    if (base === undefined) return { status: 'failed', code: 'rejected' };
    const source = options.folder()?.source(input.sourceId);
    const multiRead = options.multiRead?.() === true;
    const instructions = buildAssistantInstructions(source === undefined ? base.prompt : `${base.prompt}\n\n# This source's questions\n\n${source.classification.text}`, multiRead);
    const asked = valuesOf(input);
    const allowed = Math.min(REPEATS + 1, Math.max(1, (options.maxCalls?.() ?? REPEATS + 1) - 1));
    for (let call = 1; call <= allowed; call += 1) {
      // a turn that was cancelled or ran out of time while the first reply was read makes no second call
      if (call > 1 && signal.aborted) return { status: 'failed', code: 'timeout' };
      const values = call === 1 ? asked : `${asked}\n\n${NOT_A_ROUTE_NOTE}`;
      if (estimateTokens(instructions.text, values) > options.maxInputTokens()) return call === 1 ? { status: 'too-large' } : { status: 'unplaced', calls: call - 1 };
      const outcome = await routeOnce(options, instructions, input, values, signal, call);
      if (outcome !== 'not-a-route') return outcome;
    }
    return { status: 'unplaced', calls: allowed };
  };
}

/** One call of the router: a route, a failure, or `not-a-route` for a reply that is not one. */
async function routeOnce(options: RouterOptions, instructions: AssistantInstructions, input: RouterInput, values: string, signal: AbortSignal, call: number): Promise<RouterOutcome | 'not-a-route'> {
  let answer;
  const record = startModelCall({ modelRef: options.model.modelRef, promptId: ROUTER_PROMPT_ID, promptVersion: ROUTER_PROMPT_VERSION, instructionsSha256: instructions.sha256, instructions: instructions.text, values });
  try {
    answer = await options.model.call(
      { promptId: ROUTER_PROMPT_ID, version: ROUTER_PROMPT_VERSION, instructions: instructions.text, values },
      { action: ROUTER_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, sourceId: input.sourceId, investigationId: input.investigationId, ...(record.runId === undefined ? {} : { runId: record.runId }), onProviderAnswer: record.received },
      signal,
    );
  } catch (error) {
    record.end({ error, aborted: signal.aborted });
    // an event that cannot be built withholds the answer; any other failure of the call is the service's
    if (error instanceof AuditUnavailableError) throw error;
    return { status: 'failed', code: 'unreachable' };
  }
  noteModelAnswer({ ...(answer.status === 'ok' ? { model: answer.model } : {}), ...(answer.usage === undefined ? {} : { usage: answer.usage }) });
  if (answer.status !== 'ok') {
    record.end({ aborted: signal.aborted });
    return answer.status === 'refused' ? { status: 'failed', code: 'refused' } : { status: 'failed', code: answer.code };
  }
  const read = readAssistantRoute(answer.text);
  const fits = read.ok && (input.accepts?.(read.reply) ?? true);
  record.end({ aborted: signal.aborted, ...(fits ? {} : { notARoute: true }) });
  return read.ok && fits ? { status: 'routed', reply: read.reply, calls: call } : 'not-a-route';
}
