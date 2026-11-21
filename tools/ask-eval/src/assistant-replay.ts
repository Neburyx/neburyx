import type { AssistantHooks, EvalHooks, RecordedAnswer } from './hooks.js';
import { UsageError } from './questions.js';
import type { Replay } from './replay-file.js';
import { SCRIPTED } from './replay-file.js';
import { unitsOf, type AssistantSet, type Unit } from './assistant-questions.js';

export type Hooks = EvalHooks & AssistantHooks;

/** The input a unit gives the router: its message, the keys of its view and the labelled turns of its context. */
export const inputOf = (unit: Unit) => ({ message: unit.message, viewElementKeys: unit.viewKeys, earlier: unit.earlier, ...(unit.selectedKeys.length === 0 ? {} : { selectionKeys: unit.selectedKeys }) });

/** Whether the message writes the value as a word of its own: a value inside a longer identifier does not count as written. */
export const writtenIn = (wording: string, value: string): boolean => {
  const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(wording.toLowerCase());
};

/** The reply a router would give for what a unit expects: the scripted answer. A clarification names its candidates by the keys of the thread's context. */
async function scriptedReply(unit: Unit, hooks: AssistantHooks): Promise<string> {
  const { expect } = unit;
  if (expect.route === 'view') return JSON.stringify({ route: 'view', ...(expect.types === undefined ? {} : { types: expect.types }), ...(expect.form === undefined ? {} : { form: expect.form }) });
  if (expect.route === 'meaning') return JSON.stringify({ route: 'meaning', types: expect.types });
  if (expect.route === 'refuse') return JSON.stringify({ route: 'refuse', cause: expect.cause });
  if (expect.route === 'ask') {
    // a value the message does not write, that an element of the earlier turns or the view holds, is named by that element's key under its role, as the router prompt asks; a written value stays text
    const held = await hooks.contextKeys(unit.set.source, unit.earlier, unit.viewKeys);
    const wording = unit.message.toLowerCase();
    const entities: Record<string, string> = {};
    const elements: Record<string, string> = {};
    for (const [role, value] of Object.entries(expect.entities)) {
      const key = writtenIn(wording, value) ? undefined : Object.entries(held).find(([, stableId]) => stableId === value)?.[0];
      if (key === undefined) entities[role] = value;
      else elements[role] = key;
    }
    return JSON.stringify({ route: 'ask', intent: expect.intent, entities, ...(Object.keys(elements).length === 0 ? {} : { elements }) });
  }
  const keys = await hooks.contextKeys(unit.set.source, unit.earlier, unit.viewKeys);
  const keyOf = (stableId: string): string => {
    const found = Object.entries(keys).find(([, id]) => id === stableId)?.[0];
    if (found === undefined) throw new UsageError(`the request ${unit.name} offers a candidate that the context of its turns does not hold`);
    return found;
  };
  return JSON.stringify({ route: 'clarify', intent: expect.intent, role: expect.role, entities: expect.entities, candidates: expect.candidates.map((candidate) => keyOf(candidate.stableId)) });
}

/** The two requests of every unit of the sets, keyed by the unit's name: the values the router sends. Two units may make the same first request only with the same label, since the replay is keyed by it. */
export async function requestsOf(sets: readonly AssistantSet[], hooks: AssistantHooks): Promise<ReadonlyMap<string, { readonly first: string; readonly repeat: string }>> {
  const found = new Map<string, { first: string; repeat: string }>();
  const firsts = new Map<string, string>();
  for (const unit of unitsOf(sets)) {
    const request = await hooks.routerRequests(unit.set.source, inputOf(unit));
    const label = JSON.stringify(unit.expect);
    if (firsts.has(request.first) && firsts.get(request.first) !== label) throw new UsageError(`the request ${unit.name} is the same as another request of the run with another label`);
    firsts.set(request.first, label);
    found.set(unit.name, request);
  }
  return found;
}

/** The replay in which every unit gets the route its own expectation describes: no model, for the mechanism and for CI until a recording exists. The text hash of each source is the router's. */
export async function scriptedAssistantReplay(sets: readonly AssistantSet[], hooks: AssistantHooks): Promise<Replay> {
  const answers: Record<string, RecordedAnswer> = {};
  const folders: Record<string, string> = {};
  const requests = await requestsOf(sets, hooks);
  for (const set of sets) folders[set.source.sourceId] = await hooks.routerTextSha256(set.source);
  for (const unit of unitsOf(sets)) {
    const request = requests.get(unit.name);
    if (request !== undefined) answers[request.first] = { reply: await scriptedReply(unit, hooks) };
  }
  return { note: SCRIPTED, folders, answers };
}

/** Refuses a replay recorded for another router text, and one that holds an answer to a request no unit makes (the number is named, never the text). */
export async function checkAssistantReplay(sets: readonly AssistantSet[], replay: Replay, hooks: AssistantHooks): Promise<void> {
  for (const set of sets) {
    if (replay.folders[set.source.sourceId] !== (await hooks.routerTextSha256(set.source))) throw new UsageError(`the replay was recorded for another router text of ${set.source.sourceId}`);
  }
  const asked = new Set<string>();
  for (const request of (await requestsOf(sets, hooks)).values()) {
    asked.add(request.first);
    asked.add(request.repeat);
  }
  const stray = Object.keys(replay.answers).filter((values) => !asked.has(values)).length;
  if (stray > 0) throw new UsageError(`the replay holds ${stray} answer${stray === 1 ? '' : 's'} to requests that no message or turn of the set makes`);
}
