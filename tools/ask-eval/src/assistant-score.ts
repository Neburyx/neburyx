import { readAssistantRoute } from '@neburyx/contracts';
import type { RecordedAnswer, RouteOutcome } from './hooks.js';
import { unitsOf, type AssistantExpect, type AssistantSet } from './assistant-questions.js';
import { inputOf, requestsOf, type Hooks } from './assistant-replay.js';
import { replayOf, type Replay } from './replay-file.js';
import type { Scored } from './score.js';

/** A scored message or turn; a refusal keeps the cause it expected, so that the report can count each cause. */
export interface AssistantScored extends Scored {
  readonly refusalCause?: string;
  /** What the first reply of the router was; absent when the request has no recorded first reply. */
  readonly first?: FirstReply;
  /** The router's calls for this request: 1, or 2 when the first reply was not a route. */
  readonly calls?: number;
  /** The router ended without a route after its repeat. */
  readonly unplaced?: boolean;
  /** The router took the route of its first reply: a route, in one call. */
  readonly routedOnFirst?: boolean;
}

/** The kinds of first reply: a bare route; a route with text before or after it; a reply with no route in it; a route the turn did not accept (a clarification of elements not in the context); a failed or refused call. */
export type FirstReply = 'bare' | 'text-around' | 'wrong-form' | 'did-not-fit' | 'failed';

/** The route object inside a reply that holds text around it: from its first brace to its last. */
function recoverable(text: string): boolean {
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  return open >= 0 && close > open && readAssistantRoute(text.slice(open, close + 1)).ok;
}

/** What a first reply was, from its recorded text and whether the router needed a second call. */
function firstOf(answer: RecordedAnswer | undefined, calls: number): FirstReply | undefined {
  if (answer === undefined) return undefined;
  if (!('reply' in answer)) return 'failed';
  if (readAssistantRoute(answer.reply).ok) return calls > 1 ? 'did-not-fit' : 'bare';
  return recoverable(answer.reply) ? 'text-around' : 'wrong-form';
}

const sameValues = (left: Readonly<Record<string, string | number | boolean>>, right: Readonly<Record<string, string>>): boolean => {
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every((name) => right[name] === left[name]);
};

/** The values a reply gives for each role: the typed ones, and for each role it named by a key of the context the stable id that key stood for in this turn; a key the context does not hold gives no value. */
function valuesOf(entities: Readonly<Record<string, string | number | boolean>>, elements: Readonly<Record<string, string>> | undefined, keys: Readonly<Record<string, string>>): Readonly<Record<string, string | number | boolean>> | undefined {
  const resolved: Record<string, string | number | boolean> = { ...entities };
  for (const [role, key] of Object.entries(elements ?? {})) {
    const stableId = keys[key];
    if (stableId === undefined) return undefined;
    resolved[role] = stableId;
  }
  return resolved;
}

/** Why a router's outcome misses what a unit expects, or undefined when it is right: the route, and for a plan its intent and every entity, for a clarification also its role and candidates, for a refusal its cause. */
/** Whether two lists name the same types, whatever the order and the case. */
const sameNames = (left: readonly string[], right: readonly string[]): boolean => {
  const lower = (names: readonly string[]): string => JSON.stringify([...new Set(names.map((name) => name.trim().toLowerCase()))].sort());
  return lower(left) === lower(right);
};

function missOf(expect: AssistantExpect, outcome: RouteOutcome): string | undefined {
  if (outcome.status === 'unplaced') return 'unplaced';
  if (outcome.status !== 'routed') return 'failed';
  const { reply } = outcome;
  if (reply.route !== expect.route) return 'wrong-route';
  if (expect.route === 'meaning' && reply.route === 'meaning') return sameNames(reply.types, expect.types) ? undefined : 'wrong-types';
  if (expect.route === 'view' && reply.route === 'view') {
    if ((reply.form ?? 'sentences') !== (expect.form ?? 'sentences')) return 'wrong-form';
    return sameNames(reply.types ?? [], expect.types ?? []) ? undefined : 'wrong-types';
  }
  if (expect.route === 'refuse' && reply.route === 'refuse') return reply.cause === expect.cause ? undefined : 'wrong-cause';
  if (expect.route === 'ask' && reply.route === 'ask') {
    if (reply.intent !== expect.intent) return 'wrong-intent';
    const values = valuesOf(reply.entities, reply.elements, outcome.keys);
    return values !== undefined && sameValues(values, expect.entities) ? undefined : 'wrong-entities';
  }
  if (expect.route === 'clarify' && reply.route === 'clarify') {
    if (reply.intent !== expect.intent) return 'wrong-intent';
    const values = valuesOf(reply.entities, reply.elements, outcome.keys);
    if (reply.role !== expect.role || values === undefined || !sameValues(values, expect.entities)) return 'wrong-entities';
    const offered = reply.candidates.map((key) => outcome.keys[key]);
    const wanted = expect.candidates.map((candidate) => candidate.stableId);
    return offered.length === wanted.length && wanted.every((id) => offered.includes(id)) ? undefined : 'wrong-candidates';
  }
  return undefined;
}

/** Scores a replay with the product's own router: a request whose first form has no recorded answer is `no-reply`; every other one is the router's reading of the recorded replies, with its single repeat. */
export async function scoreAssistantReplay(sets: readonly AssistantSet[], replay: Replay, hooks: Hooks): Promise<AssistantScored[]> {
  const answers = replayOf(replay);
  const provider = hooks.replayProvider(answers as ReadonlyMap<string, RecordedAnswer>);
  const requests = await requestsOf(sets, hooks);
  const scored: AssistantScored[] = [];
  for (const unit of unitsOf(sets)) {
    const first = requests.get(unit.name)?.first;
    const refusalCause = unit.expect.route === 'refuse' ? { refusalCause: unit.expect.cause } : {};
    const expect = unit.expect.route === 'refuse' ? ('refuse' as const) : ('plan' as const);
    if (first === undefined || !answers.has(first)) {
      scored.push({ name: unit.name, expect, miss: 'no-reply', unsupported: false, ...refusalCause });
      continue;
    }
    const outcome = await hooks.routeMessage(unit.set.source, provider, 'replay', inputOf(unit));
    const miss = missOf(unit.expect, outcome);
    const calls = 'calls' in outcome ? outcome.calls : 1;
    const kind = firstOf(answers.get(first), calls);
    scored.push({ name: unit.name, expect, ...(miss === undefined ? {} : { miss }), unsupported: false, ...refusalCause, calls, ...(kind === undefined ? {} : { first: kind }), ...(outcome.status === 'unplaced' ? { unplaced: true } : {}), ...(outcome.status === 'routed' && outcome.calls === 1 ? { routedOnFirst: true } : {}) });
  }
  return scored;
}
