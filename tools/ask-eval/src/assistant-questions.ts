import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { ASSISTANT_REFUSAL_CAUSES } from '@neburyx/contracts';
import type { LabelledTurn, SourceHandle } from './hooks.js';
import { UsageError } from './questions.js';

const MAX_WORDING_CODE_POINTS = 1000;
const MIN_TURNS = 2;
const MAX_TURNS = 5;

const elementSchema = z.strictObject({ entityType: z.string().min(1), stableId: z.string().min(1) });
const typeNames = z.array(z.string().min(1)).min(1).max(8);
/** A view question; `types` when the message also asks what types mean (the router adds their names to its view reply). */
const viewSchema = z.strictObject({ route: z.literal('view'), view: z.array(elementSchema).min(1), types: typeNames.optional() });
/** A question that asks only what types mean: the router copies their names; no view is needed. */
const meaningSchema = z.strictObject({ route: z.literal('meaning'), types: typeNames });
const refuseSchema = z.strictObject({ route: z.literal('refuse'), cause: z.enum(ASSISTANT_REFUSAL_CAUSES) });
const askSchema = z.strictObject({ route: z.literal('ask'), intent: z.string().min(1), entities: z.record(z.string(), z.string()) });
const clarifySchema = z.strictObject({ route: z.literal('clarify'), intent: z.string().min(1), role: z.string().min(1), entities: z.record(z.string(), z.string()), candidates: z.array(elementSchema).min(2) });

const messageSchema = z.strictObject({ id: z.string().min(1), wording: z.string(), expect: z.union([viewSchema, meaningSchema, refuseSchema, askSchema]) });
const turnSchema = z.strictObject({ message: z.string(), expect: z.union([viewSchema, meaningSchema, refuseSchema, askSchema, clarifySchema]) });
const threadSchema = z.strictObject({ id: z.string().min(1), turns: z.array(turnSchema) });
const fileSchema = z.strictObject({ messages: z.array(messageSchema), threads: z.array(threadSchema).optional() });

export type AssistantExpect = z.infer<typeof turnSchema>['expect'];
type AssistantMessage = z.infer<typeof messageSchema>;
type AssistantThread = z.infer<typeof threadSchema>;

export interface AssistantFile {
  readonly messages: readonly AssistantMessage[];
  readonly threads: readonly AssistantThread[];
}

/** Whether an earlier turn names an element: a view that lists it, or a plan that ran for its stable id. */
const names = (turn: AssistantThread['turns'][number], element: { readonly entityType: string; readonly stableId: string }): boolean => {
  if (turn.expect.route === 'view') return turn.expect.view.some((shown) => shown.entityType === element.entityType && shown.stableId === element.stableId);
  return turn.expect.route === 'ask' && Object.values(turn.expect.entities).includes(element.stableId);
};

/**
 * Reads a set of labelled assistant messages and threads strictly. A problem names the id (or its place) and never repeats a wording or a value. `window` is the number of earlier turns the router is shown: a clarification
 * may offer only elements that a turn inside it names.
 */
export function readAssistantFile(text: string, window: number): AssistantFile {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    throw new UsageError('the question file is not valid YAML');
  }
  const read = fileSchema.safeParse(data);
  if (!read.success) throw new UsageError(`the question file is not in the expected form: ${read.error.issues[0]?.path.join('.') ?? ''}`);
  const seen = new Set<string>();
  const once = (id: string): void => {
    if (seen.has(id)) throw new UsageError(`the id ${id} is used twice`);
    seen.add(id);
  };
  const wording = (id: string, text: string): void => {
    if (text.trim() === '') throw new UsageError(`the message ${id} has an empty wording`);
    if ([...text].length > MAX_WORDING_CODE_POINTS) throw new UsageError(`the message ${id} is longer than ${MAX_WORDING_CODE_POINTS} code points`);
  };
  for (const message of read.data.messages) {
    once(message.id);
    wording(message.id, message.wording);
  }
  const threads = read.data.threads ?? [];
  for (const thread of threads) {
    once(thread.id);
    if (thread.turns.length < MIN_TURNS || thread.turns.length > MAX_TURNS) throw new UsageError(`the thread ${thread.id} has ${thread.turns.length} turns: it needs ${MIN_TURNS} to ${MAX_TURNS}`);
    thread.turns.forEach((turn, index) => {
      wording(`${thread.id}#${index + 1}`, turn.message);
      if (turn.expect.route !== 'clarify') return;
      if (index === 0) throw new UsageError(`the thread ${thread.id} asks for a clarification in its first turn, which has no context`);
      const inWindow = thread.turns.slice(0, index).filter((earlier) => earlier.expect.route !== 'clarify').slice(-window);
      for (const candidate of turn.expect.candidates) if (!inWindow.some((earlier) => names(earlier, candidate))) throw new UsageError(`the thread ${thread.id} turn ${index + 1} offers a candidate that no turn of its context names`);
    });
  }
  return { messages: read.data.messages, threads };
}

/** The messages and threads of one source and its loaded folder. */
export interface AssistantSet {
  readonly label: string;
  readonly source: SourceHandle;
  readonly messages: readonly AssistantMessage[];
  readonly threads: readonly AssistantThread[];
}

/** One request to score: a single message, or a turn of a thread with the labelled earlier turns that make its context. */
export interface Unit {
  readonly name: string;
  readonly set: AssistantSet;
  readonly message: string;
  readonly expect: AssistantExpect;
  readonly earlier: readonly LabelledTurn[];
  /** The keys of the elements in view when the message is sent: the view of the message itself, or the latest view of its thread, as the panel sends the current view with every message. */
  readonly viewKeys: readonly string[];
}

const labelled = (expect: AssistantExpect): LabelledTurn | undefined => {
  if (expect.route === 'view') return { route: 'view', cited: expect.view };
  if (expect.route === 'refuse') return { route: 'refuse', cause: expect.cause };
  if (expect.route === 'ask') return { route: 'ask', intent: expect.intent, entities: expect.entities };
  return undefined;
};

/** Every request of the sets, in order: the single messages, then the turns of each thread. A clarification is not kept in a thread, so it is not part of the context of the turns after it. */
export function unitsOf(sets: readonly AssistantSet[]): readonly Unit[] {
  const units: Unit[] = [];
  for (const set of sets) {
    for (const message of set.messages) units.push({ name: `${set.label}/${message.id}`, set, message: message.wording, expect: message.expect, earlier: [], viewKeys: viewKeysOf(set.source.sourceId, message.expect) });
    for (const thread of set.threads) {
      const earlier: LabelledTurn[] = [];
      let view: readonly string[] = [];
      thread.turns.forEach((turn, index) => {
        if (turn.expect.route === 'view') view = viewKeysOf(set.source.sourceId, turn.expect);
        units.push({ name: `${set.label}/${thread.id}#${index + 1}`, set, message: turn.message, expect: turn.expect, earlier: [...earlier], viewKeys: view });
        const kept = labelled(turn.expect);
        if (kept !== undefined) earlier.push(kept);
      });
    }
  }
  return units;
}

/** Checks the sets against their folders, so that no request can be unanswerable for a reason that is the file's. */
export function checkAssistantSets(sets: readonly AssistantSet[]): void {
  const ids = new Set<string>();
  for (const set of sets) {
    const wordings = new Set<string>();
    for (const message of set.messages) {
      const name = `${set.label}/${message.id}`;
      if (ids.has(name)) throw new UsageError(`the id ${name} is used twice`);
      ids.add(name);
      if (wordings.has(message.wording)) throw new UsageError(`the wording of ${name} is used by another message of its set`);
      wordings.add(message.wording);
    }
    for (const thread of set.threads) {
      const name = `${set.label}/${thread.id}`;
      if (ids.has(name)) throw new UsageError(`the id ${name} is used twice`);
      ids.add(name);
    }
  }
  for (const unit of unitsOf(sets)) {
    const { expect, set, name } = unit;
    if (expect.route !== 'ask' && expect.route !== 'clarify') continue;
    const intent = set.source.intents.find((candidate) => candidate.name === expect.intent);
    if (intent === undefined) throw new UsageError(`the request ${name} expects an intent that the folder does not have`);
    const wanted = expect.route === 'ask' ? [...intent.parameters] : intent.parameters.filter((role) => role !== expect.role);
    if (expect.route === 'clarify' && !intent.parameters.includes(expect.role)) throw new UsageError(`the request ${name} names a role that its intent does not have`);
    if (Object.keys(expect.entities).sort().join('\u0000') !== wanted.sort().join('\u0000')) throw new UsageError(`the request ${name} expects entities that are not exactly the parameters of its intent`);
  }
}

/** A hash of the labelled messages and threads, so that a baseline made for other ones is refused: stable under the order of the file. */
export function assistantSetHash(sets: readonly AssistantSet[]): string {
  const parts = sets.flatMap((set) => [
    ...set.messages.map((message) => JSON.stringify([set.label, message.id, message.wording, message.expect])),
    ...set.threads.map((thread) => JSON.stringify([set.label, thread.id, thread.turns.map((turn) => [turn.message, turn.expect])])),
  ]).sort();
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

/** The keys of the elements a request is asked over, as the product's panel sends them. */
const viewKeysOf = (sourceId: string, expect: AssistantExpect): readonly string[] => (expect.route === 'view' ? expect.view.map((element) => JSON.stringify(['node', sourceId, element.entityType, element.stableId])) : []);
