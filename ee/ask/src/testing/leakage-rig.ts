import { createHmac } from 'node:crypto';
import { askPlanResponseSchema, ExtensionRefusal, type AiMappingView, type AskEntityMatches, type AuditEvent, type ElementRef, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { createAuditedModelCall } from '../audited.js';
import { BUILT_IN_PROMPTS, buildPromptRegistry } from '../prompts.js';
import type { ModelRequest } from '../provider.js';
import { createRequestBuilder, type RequestBuilder } from '../request.js';
import { createAskPlanRoute } from '../routes/ask-plan.js';
import { buildPropertyRules } from '../rules.js';
import { createAskPlanner } from '../planner/planner.js';
import { catalogText } from '../planner/catalog.js';
import { vocabularyText } from '../planner/vocabulary-text.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';
import { createMemoryPlanStore, type MemoryPlanStore } from './memory-plans.js';
import { queryTextIn } from './query-patterns.js';
import { createFixtureProvider, replyKey, type FixtureReplySource } from './fixture.js';

/**
 * Test support for the leakage and injection suites: it runs a typed question through the real plan path (resolution with a stand-in search, the rebuild, the preview, the hash check,
 * the send, the planner, the request builder and the audited call) and hands back what the provider received. Production code never imports it.
 */

const SOURCE = 'demo';
const KEY = 'a-key-that-the-rig-uses-to-sign-previews';
const SIGNAL = new AbortController().signal;

export const RIG_VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }] };

const exact = (value: number) => ({ quality: 'exact' as const, value, scope: 'exact matches' });

export interface RigOptions {
  /** What the stand-in search finds for a typed text; a text that is not here finds nothing. */
  readonly known?: Readonly<Record<string, readonly ElementRef[]>>;
  /** The reply of the model to the plan prompt (and to the repair prompt unless `repairReply` is given). A refusal when none is given. */
  readonly reply?: FixtureReplySource;
  readonly repairReply?: FixtureReplySource;
  /** Wraps the real request builder; the leaky builder of the tests goes in here. */
  readonly wrapBuilder?: (builder: RequestBuilder) => RequestBuilder;
  readonly view?: AiMappingView;
  /** What the investigator chose for spans of the message (an entity, or a value to search for), sent with the preview and with the send. */
  readonly resolutions?: readonly unknown[];
  /** Wraps the plan route: a double of the route that does something the real one must not. */
  readonly wrapRoute?: (route: ExtensionRoute) => ExtensionRoute;
}

export interface RigRun {
  /** What the route answered at each step (the preview, then the plan), or the refusal it threw. */
  readonly answers: readonly unknown[];
  readonly refusal: ExtensionRefusal | undefined;
  /** Every request the provider received, in order. */
  readonly requests: readonly ModelRequest[];
  readonly events: readonly AuditEvent[];
  readonly store: MemoryPlanStore;
}

export const widgetRef = (stableId: string, entityType = 'widget'): ElementRef => ({ sourceId: SOURCE, entityType, stableId });

const DEFAULT_REPLY: FixtureReplySource = { kind: 'refused' };

/** Runs one typed message through the whole path, confirming the preview the way the application does. */
export async function runRig(message: string, options: RigOptions = {}): Promise<RigRun> {
  const view = options.view ?? RIG_VIEW;
  const built = await buildPromptRegistry();
  if (!built.ok) throw new Error(built.problems.join('; '));
  const reply = options.reply ?? DEFAULT_REPLY;
  const provider = createFixtureProvider({
    registry: built.registry,
    replies: { [replyKey('ask.plan', BUILT_IN_PROMPTS['ask.plan'].version)]: reply, [replyKey('ask.plan.repair', BUILT_IN_PROMPTS['ask.plan.repair'].version)]: options.repairReply ?? reply },
  });
  const events: AuditEvent[] = [];
  const model = createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'configured-model' }, sink: { record: async (event) => void events.push(event) } });
  const { rules, problems } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new Error(problems.join('; '));
  const realBuilder = createRequestBuilder(rules);
  const planner = createAskPlanner({ model, requestBuilder: options.wrapBuilder === undefined ? realBuilder : options.wrapBuilder(realBuilder), view });
  const store = createMemoryPlanStore();
  const base = createAskPlanRoute({ vocabulary: () => questionVocabulary({ view }), plans: () => store });
  const route = options.wrapRoute === undefined ? base : options.wrapRoute(base);
  const known = options.known ?? {};
  const search = async ({ text }: { readonly text: string }): Promise<AskEntityMatches> => ({ refs: known[text] ?? [], unreferenced: 0, count: exact((known[text] ?? []).length) });
  const request = (body: unknown): ExtensionRequest => ({
    principalId: 'p',
    principalRole: 'investigator',
    previewOn: true,
    traceId: 'tr',
    audit: { record: async () => undefined },
    askPlanner: planner,
    previewMac: (canonical) => createHmac('sha256', KEY).update(canonical).digest('hex'),
    policyVersionOf: () => 'none',
    askEntityTools: () => ({ search, lookup: async () => true, ensureSource: async () => undefined }),
    body,
  });
  const answers: unknown[] = [];
  let refusal: ExtensionRefusal | undefined;
  try {
    const chosen = options.resolutions === undefined ? {} : { resolutions: options.resolutions };
    const first = askPlanResponseSchema.parse(await route.handler(request({ message, sourceId: SOURCE, ...chosen })));
    answers.push(first);
    if ('preview' in first) answers.push(askPlanResponseSchema.parse(await route.handler(request({ message, sourceId: SOURCE, ...chosen, send: true, previewHash: first.previewHash }))));
  } catch (error) {
    if (!(error instanceof ExtensionRefusal)) throw error;
    refusal = error;
  }
  // every request the provider received is read for query text, except the `reply` of the repair prompt, which holds the previous reply of the model verbatim by design
  provider.calls.forEach((call, index) => {
    const read = call.promptId === 'ask.plan.repair' ? { ...call, parameters: { ...call.parameters, reply: '' } } : call;
    const found = queryTextIn(JSON.stringify(read));
    if (found.length > 0) throw new Error(`request ${index + 1} holds query text: ${found.join(', ')}`);
  });
  return { answers, refusal, requests: provider.calls, events, store };
}

/** The request the provider would receive for a question that holds no typed value: the prompt, the catalog and the vocabulary only. Nothing typed can be in it. */
export async function baselineRequest(view: AiMappingView = RIG_VIEW): Promise<string> {
  const { rules, problems } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new Error(problems.join('; '));
  const built = createRequestBuilder(rules).ask({ question: '', catalog: catalogText(), vocabulary: vocabularyText(view), patterns: '' });
  return JSON.stringify(built.request);
}

/** The builder of the tests that must fail: it puts the typed message into the request in place of the rebuilt question. */
export function leakyBuilder(typedMessage: string): (builder: RequestBuilder) => RequestBuilder {
  return (builder) => ({ ...builder, ask: (input) => builder.ask({ ...input, question: typedMessage }), askRepair: (input) => builder.askRepair({ ...input, question: typedMessage }) });
}

export type TokenKind = 'name' | 'id' | 'email' | 'number';
export interface TypedToken {
  readonly kind: TokenKind;
  readonly text: string;
}

interface Part {
  readonly label: string;
  readonly text: string;
}

const MIN_WORD = 3;
const MIN_DIGITS = 4;

function partsOf(token: TypedToken): readonly Part[] {
  const whole: Part = { label: `${token.kind}`, text: token.text };
  switch (token.kind) {
    case 'email': {
      const [local = '', domain = ''] = token.text.split('@');
      return [whole, { label: 'email local part', text: local }, { label: 'email domain', text: domain }].filter((part) => part.text.length >= MIN_WORD);
    }
    case 'name':
      return [whole, ...token.text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= MIN_WORD).map((word) => ({ label: 'name word', text: word }))];
    case 'id':
    case 'number': {
      const digits = token.text.match(/\d+/g) ?? [];
      const runs = digits.filter((run) => run.length >= MIN_DIGITS).map((run) => ({ label: `${token.kind} digits`, text: run }));
      // a number of three digits or fewer is not a typed token: the allowlist keeps it
      return token.kind === 'number' && runs.length === 0 ? [] : [whole, ...runs];
    }
    default: {
      const unreachable: never = token.kind;
      return unreachable;
    }
  }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const appearsIn = (text: string, haystack: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(text)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);

/**
 * What of the typed tokens appears in the requests. A part that is in the baseline request cannot be told from a leak, so the check refuses the token before it looks (the test chose a bad token).
 * The answer names the kind of each leak and the request it was in, never the text.
 */
export function leaksIn(requests: readonly ModelRequest[], tokens: readonly TypedToken[], baseline: string): readonly string[] {
  const found: string[] = [];
  for (const token of tokens) {
    for (const part of partsOf(token)) {
      if (appearsIn(part.text, baseline)) throw new Error(`a ${part.label} of a ${token.kind} token is part of the baseline request: choose another token`);
      requests.forEach((request, index) => {
        if (appearsIn(part.text, JSON.stringify(request))) found.push(`${part.label} of a ${token.kind} token in request ${index + 1}`);
      });
    }
  }
  return found;
}

/** A rig run that was expected to reach the model must have; one that was expected not to must not have. A blocked question cannot pass for nothing. */
export function assertReach(run: RigRun, reachesModel: boolean): void {
  if (reachesModel && run.requests.length === 0) throw new Error('the question was expected to reach the model and no request was made');
  if (!reachesModel && run.requests.length > 0) throw new Error(`the question was expected not to reach the model and ${run.requests.length} request(s) were made`);
}
