import {
  ASK_SAVED_PATTERN_INTENT,
  ASSISTANT_CONTINUE_INVALID_SENTENCE,
  ASSISTANT_NOT_ANSWERED_SENTENCE,
  ASSISTANT_REFUSAL_SENTENCES,
  ASSISTANT_TOO_LARGE_SENTENCE,
  ExtensionRefusal,
  assistantTurnAnswerSchema,
  assistantTurnRequestSchema,
  type AskAnswer,
  type AskFolder,
  type AskPatternOffer,
  type AssistantFailureKind,
  type AssistantTurnAnswer,
  type AssistantTurnRequest,
  type ExtensionLogger,
  type ExtensionRequest,
  type ExtensionRoute,
  type RecordQueue,
} from '@neburyx/contracts';
import { AuditUnavailableError, gateClientOf, type FailureCode } from '@neburyx/ee-ai-runtime';
import { buildPatternCatalog } from '../patterns/index.js';
import { coverageOf } from './coverage.js';
import { summarizeRun } from '../questions/run-summary.js';
import { capabilitiesOf, definitionOf, execute, patternDefinitionOf, patternOf, refusal, writeEvent, type Execution } from '../questions/question-routes.js';
import { canonicalText } from '../questions/canonical.js';
import { verifyContinueToken } from '../questions/continue-token.js';
import type { RouterInput, RouterOutcome } from './router.js';
import type { AssistantRunStore } from './run-store.js';
import type { AssistantThreadStore } from './thread-store.js';
import type { AssistantSettings } from './settings.js';
import { noteTurnStarted, withTurnAudit } from './turn-audit.js';
import { countWords } from './words.js';

const TURNS_URL = '/v1/assistant/turns';
const ASK_ACTION = 'assistant.ask';
const CONTINUE_ACTION = 'assistant.continue';
const MILLISECONDS_A_SECOND = 1000;

export interface TurnRouteOptions {
  readonly maxMessageWords: () => number | undefined;
  readonly router: () => ((input: RouterInput, signal: AbortSignal) => Promise<RouterOutcome>) | undefined;
  readonly folder: () => AskFolder | undefined;
  readonly logger: () => ExtensionLogger | undefined;
  /** The store of the records of the turns' model calls; absent, nothing is recorded. */
  readonly runs?: () => AssistantRunStore | undefined;
  readonly runSettings?: () => AssistantSettings | undefined;
  /** The store of the threads and the queue of the records its writes go through; absent, no thread is kept. */
  readonly threads?: () => AssistantThreadStore | undefined;
  readonly records?: () => RecordQueue | undefined;
  readonly now?: () => number;
}

/** The keyed hash of what the person typed, made with the application's signing key, so a short message cannot be confirmed by guessing; absent when the application has no key. */
const hashOf = (request: ExtensionRequest, parts: readonly unknown[]): { readonly questionHash?: string } => (request.signText === undefined ? {} : { questionHash: request.signText(canonicalText(parts)) });

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });

const refused = (cause: Extract<AssistantTurnAnswer, { route: 'refuse' }>['cause']): AssistantTurnAnswer => ({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] });

const kindOf = (code: FailureCode | 'refused'): AssistantFailureKind => (code === 'timeout' ? 'timeout' : code === 'rate-limited' ? 'rate-limit' : 'service');

/** A failure of the gate's read that is the person's to retry, as the answer of a turn; every other refusal goes on as the gate gave it, as Ask gives it. */
function unavailableOf(error: unknown): AssistantTurnAnswer | undefined {
  if (!(error instanceof ExtensionRefusal)) return undefined;
  switch (error.code) {
    case 'QUERY_TIMEOUT':
      return { status: 'unavailable', kind: 'timeout', readStarted: true };
    case 'SOURCE_UNAVAILABLE':
      return { status: 'unavailable', kind: 'source-unavailable', readStarted: true };
    case 'SOURCE_BUSY':
      return { status: 'unavailable', kind: 'busy', readStarted: true };
    case 'RATE_LIMITED':
      return { status: 'unavailable', kind: 'rate-limit', readStarted: true, ...(error.retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / MILLISECONDS_A_SECOND)) }) };
    default:
      return undefined;
  }
}

const answeredAsk = (answer: AskAnswer): AssistantTurnAnswer => {
  if ('refused' in answer || answer.answered.continueToken !== undefined) return { status: 'answered', route: 'ask', answer };
  const { result, intent, outcome } = answer.answered;
  const { rowCount } = summarizeRun(result);
  return { status: 'answered', route: 'ask', answer, step: { intent, rows: rowCount, outcome }, coverage: coverageOf(result) };
};

async function runAndAnswer(run: Execution): Promise<AssistantTurnAnswer> {
  if (run.request.signal.aborted) throw new Error('the request was cancelled');
  try {
    return answeredAsk(await execute(run));
  } catch (error) {
    const unavailable = unavailableOf(error);
    if (unavailable === undefined) throw error;
    return unavailable;
  }
}

export function createAssistantTurnRoute(options: TurnRouteOptions): ExtensionRoute {
  const runOptions = { folder: options.folder, runs: () => undefined, logger: options.logger, ...(options.now === undefined ? {} : { now: options.now }) };

  async function continueTurn(request: ExtensionRequest, body: AssistantTurnRequest, asked: Extract<AssistantTurnRequest, { continue: unknown }>['continue']): Promise<AssistantTurnAnswer> {
    const capabilities = capabilitiesOf(request);
    const mask = body.mask === true;
    let offer: AskPatternOffer | undefined;
    let definition: string | undefined;
    if (asked.intent === ASK_SAVED_PATTERN_INTENT) {
      const { findPattern } = gateClientOf(request);
      if (findPattern === undefined) throw unsupported();
      offer = await patternOf(findPattern, body.sourceId, asked.entities);
      definition = offer === undefined ? undefined : patternDefinitionOf(offer);
    } else {
      const found = options.folder()?.intent(body.sourceId, asked.intent);
      definition = found === undefined ? undefined : definitionOf(found);
    }
    const binding = { principalId: request.principalId, sourceId: body.sourceId, intent: asked.intent, definition: definition ?? '', entities: asked.entities, mask, investigationId: body.investigationId };
    if (definition === undefined || !verifyContinueToken(capabilities.signText, asked.continueToken, binding, (options.now ?? Date.now)())) {
      await writeEvent(request, CONTINUE_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: 'continue-invalid' });
      return { status: 'continue-invalid', sentence: ASSISTANT_CONTINUE_INVALID_SENTENCE };
    }
    return runAndAnswer({ request, capabilities, options: runOptions, sourceId: body.sourceId, mask, intent: asked.intent, entities: asked.entities, continuing: true, action: CONTINUE_ACTION, investigationId: body.investigationId, ...(offer === undefined ? {} : { offer }) });
  }

  return {
    method: 'POST',
    url: TURNS_URL,
    permission: 'principal',
    requestSchema: assistantTurnRequestSchema,
    responseSchema: assistantTurnAnswerSchema,
    handler: withTurnAudit({ logger: options.logger, ...(options.runs === undefined ? {} : { runs: options.runs }), ...(options.runSettings === undefined ? {} : { settings: options.runSettings }), ...(options.threads === undefined ? {} : { threads: options.threads }), ...(options.records === undefined ? {} : { records: options.records }), ...(options.now === undefined ? {} : { now: options.now }) }, async (request: ExtensionRequest): Promise<AssistantTurnAnswer> => {
      const { sourceReadable, investigationReadable, patterns } = gateClientOf(request);
      const router = options.router();
      if (sourceReadable === undefined || investigationReadable === undefined || router === undefined) throw unsupported();
      const body = assistantTurnRequestSchema.parse(request.body);
      await sourceReadable(body.sourceId);
      await investigationReadable(body.investigationId, body.sourceId);
      if ('continue' in body) {
        await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-continue', 1, body.continue.intent]) });
        return continueTurn(request, body, body.continue);
      }
      const { message } = body;
      const words = countWords(message);
      if (words === 0) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'empty-message' });
      await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-question', 1, message]) });
      const limit = options.maxMessageWords();
      if (limit === undefined) throw unsupported();
      if (words > limit) return { status: 'too-long', words, limit };
      const listing = patterns === undefined ? undefined : await patterns(body.sourceId);
      const built = listing === undefined ? undefined : buildPatternCatalog(listing);
      let outcome: RouterOutcome;
      try {
        outcome = await router({ sourceId: body.sourceId, investigationId: body.investigationId, message, viewElementKeys: body.viewElementKeys, actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, ...(built === undefined ? {} : { patternCatalog: built.catalog.text }) }, request.signal);
      } catch (error) {
        // the model returned a prompt other than the one sent, so nothing of the call is kept
        if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
        throw error;
      }
      switch (outcome.status) {
        case 'too-large':
          return { status: 'too-large', sentence: ASSISTANT_TOO_LARGE_SENTENCE };
        case 'failed':
          return { status: 'unavailable', kind: kindOf(outcome.code), readStarted: false };
        case 'unplaced':
          return refused('unplaced');
        case 'routed': {
          const { reply } = outcome;
          if (reply.route === 'refuse') return refused(reply.cause);
          if (reply.route === 'view') return { status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };
          const capabilities = capabilitiesOf(request);
          if (options.folder()?.source(body.sourceId) === undefined) {
            await writeEvent(request, ASK_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: 'no-ask-for-source' });
            return answeredAsk(refusal('no-ask-for-source'));
          }
          return runAndAnswer({ request, capabilities, options: runOptions, sourceId: body.sourceId, mask: body.mask === true, intent: reply.intent, entities: reply.entities, continuing: false, action: ASK_ACTION, investigationId: body.investigationId, ...(built === undefined || listing === undefined ? {} : { patterns: { built, listing } }) });
        }
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }),
  };
}
