import { randomUUID } from 'node:crypto';
import type { ExtensionLogger, ExtensionRequest } from '@neburyx/contracts';
import type { ModelAnswer, TokenUsage } from '@neburyx/ee-ai-runtime';
import type { AssistantSettings } from './settings.js';
import { AssistantRunGuardError, type AssistantRunStore } from './run-store.js';

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TurnRunDeps {
  readonly runs: () => AssistantRunStore | undefined;
  readonly settings: () => AssistantSettings | undefined;
  readonly now: () => number;
  readonly logger: () => ExtensionLogger | undefined;
}

interface CallStart {
  readonly instructionsSha256: string;
  readonly instructions: string;
  readonly values: string;
  /** The names of the tools the model was bound to for this call (names only). */
  readonly tools?: readonly string[];
}

/** Why a call failed: the product's code and the class and the code of the error the provider's client threw. */
interface CallFailure {
  readonly code: string;
  readonly errorClass: string;
  readonly errorCode?: string;
  readonly errorType?: string;
}

/** The record of one model call: it is written when the call starts and once when it ends. */
export interface CallRecord {
  /** Keeps what the provider returned the moment it returns, so a call that fails after its reply still holds the reply. */
  received(answer: ModelAnswer): void;
  /** Ends the call: from the provider's answer, or, with an error, as failed; a call the client gave up before it ended is cancelled, whatever came back, and a reply that is not a route is failed. */
  end(outcome: { readonly error?: unknown; readonly aborted: boolean; readonly notARoute?: boolean; readonly failure?: CallFailure }): void;
}

export interface TurnRun {
  readonly id: string;
  startCall(call: CallStart): CallRecord;
  finish(outcome: string, calls: number): void;
}

type CallStatus = 'answered' | 'refused' | 'failed' | 'cancelled';

/** How a call ended: a call the client gave up on, or one that did not come back with a good reply, is cancelled; a call that threw after its reply came back keeps the reply and is failed. */
function endOf(answer: ModelAnswer | undefined, error: unknown, aborted: boolean, notARoute: boolean): { readonly status: CallStatus; readonly failureKind?: string } {
  if (aborted) return { status: 'cancelled' };
  if (notARoute) return { status: 'failed', failureKind: 'not-a-route' };
  if (error !== undefined) return { status: 'failed', failureKind: answer === undefined ? 'unreachable' : 'audit-unavailable' };
  if (answer === undefined) return { status: 'failed', failureKind: 'unreachable' };
  if (answer.status === 'ok') return { status: 'answered' };
  if (answer.status === 'refused') return { status: 'refused' };
  return { status: 'failed', failureKind: answer.code };
}

const durationOf = (startedAt: number, endedAt: number): number => Math.max(0, Math.round(endedAt - startedAt));

/**
 * A write that fails never changes the turn. The application's queue counts and logs the failure of a write it was given; a store used without a queue is written at once, and its failure is logged here by the run and the step, never by text.
 */
const quietly = (deps: TurnRunDeps & { readonly guardLost?: () => void }, ids: { readonly runId: string; readonly step: string }, work: () => Promise<void>): void => {
  const failed = (error?: unknown): void => {
    if (error instanceof AssistantRunGuardError) deps.guardLost?.();
    try {
      deps.logger()?.warn({ event: 'assistant-run.not-recorded', ...ids }, 'a record of an assistant turn could not be written');
    } catch {
      // a logger that fails changes nothing
    }
  };
  // the write is handed to the store at once, so it is queued before the model is asked
  try {
    work().catch(failed);
  } catch (error) {
    failed(error);
  }
};

/**
 * The run of a turn: its id is made here, before any call, and its rows are handed to the store in the order made: the run, each call's start before the call and its end after it, then the finish. Nothing here waits for the store.
 * With no store the id is still made, so the events of the turn carry it, and nothing is written.
 */
export function createTurnRun(base: TurnRunDeps, request: ExtensionRequest, started: { readonly sourceId: string; readonly investigationId: string; readonly threadEpoch?: number; /** Told when the guard of a write of this run cannot be read, so the turn is not stored in its thread. */ readonly guardLost?: () => void }): TurnRun {
  const deps = { ...base, ...(started.guardLost === undefined ? {} : { guardLost: started.guardLost }) };
  const id = randomUUID();
  const store = deps.runs();
  const settings = deps.settings();
  if (store !== undefined) {
    quietly(deps, { runId: id, step: 'begin' }, () =>
      store.begin({
        id,
        actorId: request.principalId,
        ...(UUID_TEXT.test(started.investigationId) ? { investigationId: started.investigationId } : {}),
        sourceId: started.sourceId,
        traceId: request.traceId,
        startedAt: new Date(deps.now()),
        settings: settings === undefined ? {} : { ...settings },
        ...(started.threadEpoch === undefined ? {} : { threadEpoch: started.threadEpoch }),
      }),
    );
  }
  let calls = 0;
  return {
    id,
    startCall(call) {
      calls += 1;
      const number = calls;
      const startedAt = deps.now();
      if (store !== undefined) quietly(deps, { runId: id, step: 'beginCall' }, () => store.beginCall({ runId: id, number, startedAt: new Date(startedAt), instructionsSha256: call.instructionsSha256, instructionsText: call.instructions, valuesText: call.values, ...(deps.guardLost === undefined ? {} : { onGuardLost: deps.guardLost }), ...(call.tools === undefined || call.tools.length === 0 ? {} : { toolsOffered: call.tools.join(',') }) }));
      let answer: ModelAnswer | undefined;
      let ended = false;
      return {
        received(received) {
          answer = received;
        },
        end({ error, aborted, notARoute, failure }) {
          if (ended || store === undefined) return;
          ended = true;
          const usage: TokenUsage | undefined = answer?.usage;
          const replyText = answer === undefined ? undefined : answer.status === 'ok' ? answer.text : answer.received;
          const result = endOf(answer, error, aborted, notARoute === true);
          const { status } = result;
          // a failure the audited model described says why; the generic kind is only for a call that threw something else
          const failureKind = result.status === 'failed' && failure !== undefined && answer === undefined ? failure.code : result.failureKind;
          quietly(deps, { runId: id, step: 'endCall' }, () =>
            store.endCall({
              runId: id,
              number,
              status,
              ...(failureKind === undefined ? {} : { failureKind }),
              ...(failure === undefined || status !== 'failed' ? {} : { errorClass: failure.errorClass, ...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }), ...(failure.errorType === undefined ? {} : { errorType: failure.errorType }) }),
              ...(replyText === undefined ? {} : { replyText }),
              ...(usage?.kind === 'known' ? { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } : {}),
              durationMs: durationOf(startedAt, deps.now()),
              ...(deps.guardLost === undefined ? {} : { onGuardLost: deps.guardLost }),
            }),
          );
        },
      };
    },
    finish(outcome, count) {
      if (store !== undefined) quietly(deps, { runId: id, step: 'finish' }, () => store.finish(id, outcome, count, new Date(deps.now())));
    },
  };
}
