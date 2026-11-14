import { askPlanRequestSchema, askPlanResponseSchema, ExtensionRefusal, type AiMappingView, type AskPatternCard, type AskPatternCatalog, type AskPlan, type AskPlanAnswer, type AskPlanRequest, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { AuditUnavailableError } from '../audited.js';
import { fixedRefusal } from '../refusal/families.js';
import { COMMON_WORDS_VERSION, allowedWords, rebuildPlannerText } from '../allowlist/index.js';
import { createHash } from 'node:crypto';
import { previewHashOf, hashesMatch } from '../preview/preview-hash.js';
import { PatternGuardError, buildPatternCatalog, type BuiltPatternCatalog } from '../patterns/index.js';
import { displayText } from '../patterns/catalog-text.js';
import { hydratePlan } from '../plans/hydrate.js';
import type { PlanStore } from '../plans/index.js';
import { resolveMentions, type PlaceholderEntry, type PlaceholderSpan, type ResolutionOutcome } from '../resolution/index.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';

export const ASK_PLAN_URL = '/v1/ask/plan';

/** The one sentence a plan is answered with in place of the model's own `rationale`: nothing the model wrote in free text is shown, kept or returned. */
export const PLANNED_RATIONALE = 'Proposed for your question.';

/** How long the resolution of one question may take in all: its searches go through the gate under their own budgets, and this bounds the whole. */
export const RESOLUTION_TIMEOUT_MS = 20_000;

export interface AskPlanRouteOptions {
  /** The entries the rebuild reads as vocabulary for this question; the route asks each time because the mapping is configured after the route is made. */
  readonly vocabulary?: () => readonly string[];
  /** The store a plan is kept in; asked each time because the application builds it after the route is made. A question that is sent to the planner needs it, and is refused before the model is called when there is none. */
  readonly plans?: () => PlanStore | undefined;
  /** The mapping's view the saved patterns are vetted against: their names must be types of it. */
  readonly view?: () => AiMappingView | undefined;
  /** Only a test sets this: the builder of the pattern catalog, whose text is compared with the real one's before anything is sent. */
  readonly patternCatalog?: typeof buildPatternCatalog;
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
  | { readonly kind: 'rebuilt'; readonly text: string; readonly hash: string; readonly placeholders: ReadonlyMap<string, PlaceholderEntry>; readonly patterns: BuiltPatternCatalog | undefined };

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

async function prepare(request: ExtensionRequest, body: AskPlanRequest, capabilities: Capabilities, options: Required<AskPlanRouteOptions>): Promise<Prepared> {
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
  const patterns = request.askPlanner.offersPatterns?.() === false ? undefined : await patternsOf(request, body.sourceId, options, vocabulary);
  const patternCatalogSha = patterns === undefined ? undefined : createHash('sha256').update(patterns.catalog.text, 'utf8').digest('hex');
  const hash = previewHashOf(capabilities.previewMac, { text: rebuilt.text, resolutions, policyVersion: capabilities.policyVersionOf(body.sourceId), wordListVersion: COMMON_WORDS_VERSION, ...(patternCatalogSha === undefined ? {} : { patternCatalogSha }) });
  return { kind: 'rebuilt', text: rebuilt.text, hash, placeholders: resolved.placeholders, patterns };
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
    view: options.view ?? (() => undefined),
    patternCatalog: options.patternCatalog ?? buildPatternCatalog,
    plans: options.plans ?? (() => undefined),
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
      const prepared = await prepare(request, body, capabilities, settled);
      if (prepared.kind === 'answer') return prepared.answer;
      if (body.send !== true) return previewOf(prepared);
      if (body.previewHash !== undefined && hashesMatch(body.previewHash, prepared.hash)) {
        // no store, no plan: refused before the model is called, so no plan is paid for that cannot be kept
        const plans = settled.plans();
        if (plans === undefined) throw unsupported();
        return answered(request, plans, body.sourceId, prepared.placeholders, await planOf(request, prepared.text, body.sourceId, prepared.patterns?.catalog), prepared.patterns);
      }
      return { ...previewOf(prepared), changed: true };
    },
  };
}

/** The preview: the rebuilt text and its hash, and the names of the saved patterns that will be shown with it, so the investigator sees all that the model will receive. */
function previewOf(prepared: Extract<Prepared, { kind: 'rebuilt' }>): { preview: string; previewHash: string; patternLabels?: string[]; patternText?: string; patternCatalogCut?: true } {
  const labels = prepared.patterns?.catalog.labels ?? [];
  return { preview: prepared.text, previewHash: prepared.hash, ...(labels.length === 0 ? {} : { patternLabels: [...labels] }), ...(prepared.patterns === undefined ? {} : { patternText: displayText(prepared.patterns.catalog.text) }), ...(prepared.patterns?.catalog.cut === true ? { patternCatalogCut: true as const } : {}) };
}

/** What a plan is answered with: a plan of a template is turned back into references, stored, and comes with its ID and expiry; an unsupported plan is made fixed (the family and the sentence of that family, never the planner's reason) and is not stored. */
async function answered(request: ExtensionRequest, plans: PlanStore, sourceId: string, placeholders: ReadonlyMap<string, PlaceholderEntry>, plan: AskPlan, patterns: BuiltPatternCatalog | undefined): Promise<{ plan: AskPlanAnswer; planId?: string; expiresAt?: string; patternCatalogCut?: true; patternCard?: AskPatternCard }> {
  if (plan.kind !== 'plan') return { plan: fixedRefusal(plan.family) };
  const hydrated = hydratePlan(plan, placeholders, sourceId, patterns?.targets);
  const stored = await plans.insert({ userId: request.principalId, sourceId, templateId: hydrated.templateId, templateVersion: hydrated.templateVersion, params: hydrated.params, planningTraceId: request.traceId });
  const card = await cardOf(request, sourceId, hydrated);
  return { plan: { ...hydrated, rationale: PLANNED_RATIONALE }, planId: stored.id, expiresAt: stored.expiresAt.toISOString(), ...(patterns?.catalog.cut === true ? { patternCatalogCut: true } : {}), ...(card === undefined ? {} : { patternCard: card }) };
}

/** What the plan card shows of the saved pattern a plan names, read for the caller by the same lookup the run uses: its name and structure. Not stored, not audited, not sent to the model; a pattern that is no longer one the caller may run is not shown, and the run refuses it. */
async function cardOf(request: ExtensionRequest, sourceId: string, plan: Extract<AskPlan, { kind: 'plan' }>): Promise<AskPatternCard | undefined> {
  if (plan.templateId !== 'saved-pattern' || !('patternId' in plan.params) || request.askPatternFind === undefined) return undefined;
  try {
    const offer = await request.askPatternFind(sourceId, plan.params.patternId);
    // a pattern that changed since the plan was made is not shown as it is now: the plan will not run it, and the run says so
    return offer === undefined || offer.version !== plan.params.patternVersion ? undefined : { name: offer.name, projection: offer.projection };
  } catch {
    return undefined;
  }
}

/** The catalog of the saved patterns of this question; the pattern text of the application is checked as it is built, and a builder whose text differs from the real one's stops the question before the model is asked. */
async function patternsOf(request: ExtensionRequest, sourceId: string, options: Required<AskPlanRouteOptions>, vocabulary: readonly string[]): Promise<BuiltPatternCatalog | undefined> {
  const listing = request.askPatterns === undefined ? { offers: [], cut: false } : await request.askPatterns(sourceId);
  const view = options.view();
  const real = buildPatternCatalog(listing, view, vocabulary);
  const used = options.patternCatalog(listing, view, vocabulary);
  if (real?.catalog.text !== used?.catalog.text) throw new PatternGuardError('catalog');
  return real;
}

async function planOf(request: ExtensionRequest, text: string, sourceId: string, patterns: AskPatternCatalog | undefined): Promise<AskPlan> {
  try {
    return await request.askPlanner.plan({ text, context: { actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, sourceId }, ...(patterns === undefined ? {} : { patterns }) });
  } catch (error) {
    if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
    throw error;
  }
}

export const askPlanRoute = createAskPlanRoute();
