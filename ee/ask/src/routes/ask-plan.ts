import { askPlanRequestSchema, askPlanResponseSchema, ExtensionRefusal, type AskPlan, type AskPlanRequest, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { AuditUnavailableError } from '../audited.js';
import { COMMON_WORDS_VERSION, allowedWords, rebuildPlannerText } from '../allowlist/index.js';
import { previewHashOf, hashesMatch } from '../preview/preview-hash.js';
import { resolveMentions, type PlaceholderSpan, type ResolutionOutcome } from '../resolution/index.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';

export const ASK_PLAN_URL = '/v1/ask/plan';

/** How long the resolution of one question may take in all: its searches go through the gate under their own budgets, and this bounds the whole. */
export const RESOLUTION_TIMEOUT_MS = 20_000;

export interface AskPlanRouteOptions {
  /** The entries the rebuild reads as vocabulary for this question; the route asks each time because the mapping is configured after the route is made. */
  readonly vocabulary?: () => readonly string[];
  /** Only a test sets this. */
  readonly resolve?: typeof resolveMentions;
  /** Only a test sets this. */
  readonly resolutionTimeoutMs?: number;
}

interface Capabilities {
  readonly previewMac: NonNullable<ExtensionRequest['previewMac']>;
  readonly policyVersionOf: NonNullable<ExtensionRequest['policyVersionOf']>;
  readonly askEntityTools: NonNullable<ExtensionRequest['askEntityTools']>;
}

type Prepared =
  | { readonly kind: 'answer'; readonly answer: { readonly clarification: Extract<ResolutionOutcome, { status: 'clarification' }>['clarification'] } | { readonly blocked: { readonly tokens: readonly { readonly text: string; readonly start: number; readonly end: number }[] } } }
  | { readonly kind: 'rebuilt'; readonly text: string; readonly hash: string };

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });

function capabilitiesOf(request: ExtensionRequest): Capabilities | undefined {
  const { previewMac, policyVersionOf, askEntityTools } = request;
  if (previewMac === undefined || policyVersionOf === undefined || askEntityTools === undefined) return undefined;
  return { previewMac, policyVersionOf, askEntityTools };
}

/** Where a position of the resolved text lies in the typed message, given the ranges the placeholders replaced. */
function typedOffset(position: number, spans: readonly PlaceholderSpan[], edge: 'start' | 'end'): number {
  let shift = 0;
  for (const span of spans) {
    if (position >= span.end) {
      shift += span.typedEnd - span.typedStart - (span.end - span.start);
      continue;
    }
    if (position > span.start) return edge === 'start' ? span.typedStart : span.typedEnd;
    break;
  }
  return position + shift;
}

async function prepare(body: AskPlanRequest, capabilities: Capabilities, options: Required<AskPlanRouteOptions>): Promise<Prepared> {
  const vocabulary = options.vocabulary();
  const { search, lookup, ensureSource } = capabilities.askEntityTools(body.sourceId);
  await ensureSource();
  const resolutions = body.resolutions ?? [];
  const signal = AbortSignal.timeout(options.resolutionTimeoutMs);
  const resolved = await options.resolve({ message: body.message, resolutions, sourceId: body.sourceId, search, lookup, skipWords: allowedWords(vocabulary), signal }).catch((error: unknown) => {
    if (signal.aborted) throw new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: options.resolutionTimeoutMs });
    throw error;
  });
  if (resolved.status === 'refused') throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: resolved.reason });
  if (resolved.status === 'clarification') return { kind: 'answer', answer: { clarification: resolved.clarification } };
  const rebuilt = rebuildPlannerText({ text: resolved.text, spans: resolved.spans.map(({ start, end, placeholder }) => ({ start, end, placeholder })), vocabulary });
  if (rebuilt.kind === 'blocked') {
    const tokens = rebuilt.tokens.map((token) => {
      const start = typedOffset(token.start, resolved.spans, 'start');
      const end = typedOffset(token.end, resolved.spans, 'end');
      return { text: body.message.slice(start, end), start, end };
    });
    return { kind: 'answer', answer: { blocked: { tokens } } };
  }
  const hash = previewHashOf(capabilities.previewMac, { text: rebuilt.text, resolutions, policyVersion: capabilities.policyVersionOf(body.sourceId), wordListVersion: COMMON_WORDS_VERSION });
  return { kind: 'rebuilt', text: rebuilt.text, hash };
}

/**
 * The plan endpoint. It resolves the mentions of the typed message, rebuilds the planner text from allowed tokens, and signs the rebuilt text
 * with the resolutions, the policy version and the word-list version. With `send: false` it answers the clarification, the blocked tokens or the
 * preview with its hash; with `send: true` it hands the rebuilt text to the planner only when the hash sent is the hash of the current preview,
 * and otherwise answers the new preview with `changed: true`. The planner never receives anything but the rebuilt text.
 */
export function createAskPlanRoute(options: AskPlanRouteOptions = {}): ExtensionRoute {
  const settled: Required<AskPlanRouteOptions> = {
    vocabulary: options.vocabulary ?? (() => questionVocabulary({ view: undefined })),
    resolve: options.resolve ?? resolveMentions,
    resolutionTimeoutMs: options.resolutionTimeoutMs ?? RESOLUTION_TIMEOUT_MS,
  };
  return {
    method: 'POST',
    url: ASK_PLAN_URL,
    permission: 'principal',
    requestSchema: askPlanRequestSchema,
    responseSchema: askPlanResponseSchema,
    async handler(request) {
      if (!request.askPlanner.availability().available) throw unsupported();
      const body = askPlanRequestSchema.parse(request.body);
      const capabilities = capabilitiesOf(request);
      if (capabilities === undefined) throw unsupported();
      const prepared = await prepare(body, capabilities, settled);
      if (prepared.kind === 'answer') return prepared.answer;
      if (body.send !== true) return { preview: prepared.text, previewHash: prepared.hash };
      if (body.previewHash !== undefined && hashesMatch(body.previewHash, prepared.hash)) return { plan: await planOf(request, prepared.text, body.sourceId) };
      return { preview: prepared.text, previewHash: prepared.hash, changed: true };
    },
  };
}

async function planOf(request: ExtensionRequest, text: string, sourceId: string): Promise<AskPlan> {
  try {
    return await request.askPlanner.plan({ text, context: { actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, sourceId } });
  } catch (error) {
    if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
    throw error;
  }
}

export const askPlanRoute = createAskPlanRoute();
