import { ASSISTANT_CLARIFICATION_MAX_CANDIDATES, assistantClarificationQuestion, type AskFolder, type AskIntent, type AssistantChoice, type AssistantRouterReply, type AssistantTurnAnswer, type ElementRefs, type SummaryReading } from '@neburyx/contracts';
import type { TurnContext } from './context.js';
import type { AssistantContextTurn } from './thread-store.js';

type EntityRef = AssistantContextTurn['entities'][number]['ref'];

/** One element a clarification may mean: its reference, kept by the server, and what the analyst is shown of it. */
export interface Candidate {
  readonly ref: EntityRef;
  readonly title: string;
  readonly type: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entity type the settings of a template intent place a role on, as `{ entityType, stableId: '$role' }`; undefined for a role of a file query or one that no setting places. */
export function roleEntityType(intent: AskIntent, role: string): string | undefined {
  if (intent.kind !== 'template') return undefined;
  const walk = (setting: unknown): string | undefined => {
    if (Array.isArray(setting)) return setting.map(walk).find((found) => found !== undefined);
    if (!isRecord(setting)) return undefined;
    if (setting['stableId'] === `$${role}` && typeof setting['entityType'] === 'string') return setting['entityType'];
    return Object.values(setting)
      .map(walk)
      .find((found) => found !== undefined);
  };
  return walk(intent.settings);
}

/**
 * The candidates of a clarification that the router asked for, when the reply fits this turn: the intent is a template intent of the folder, the role is one it takes and has an entity type, the values of the other roles are roles it
 * takes, every key is a key of this turn's context, and every candidate is an element of the role's entity type. Undefined otherwise.
 */
export function candidatesOfReply(reply: Extract<AssistantRouterReply, { route: 'clarify' }>, context: TurnContext | undefined, folder: AskFolder | undefined, sourceId: string): readonly Candidate[] | undefined {
  const intent = folder?.intent(sourceId, reply.intent);
  if (intent === undefined || context === undefined || !intent.parameters.includes(reply.role)) return undefined;
  const type = roleEntityType(intent, reply.role);
  const others = [...Object.keys(reply.entities), ...Object.keys(reply.elements ?? {})];
  if (type === undefined || others.some((role) => !intent.parameters.includes(role)) || Object.values(reply.elements ?? {}).some((key) => !context.keys.has(key))) return undefined;
  const candidates: Candidate[] = [];
  for (const key of reply.candidates) {
    const ref = context.keys.get(key);
    const shown = context.shown.get(key);
    if (ref === undefined || shown === undefined || ref.entityType !== type) return undefined;
    candidates.push({ ref, ...shown });
  }
  return candidates;
}

/**
 * The candidates for a key the router named that is not an element of the context: the context's elements of the role's entity type, the elements of the last turn first, then the turns before it newest first, then the elements of the view
 * in the order of the keys sent, each once and no more than the most a clarification offers. The view's elements are read again through the gate only when the turns do not fill the list.
 */
export async function candidatesFor(options: {
  readonly entityType: string;
  readonly context: TurnContext | undefined;
  readonly viewEntities: readonly EntityRef[];
  readonly read: (refs: ElementRefs) => Promise<SummaryReading>;
}): Promise<readonly Candidate[]> {
  const { entityType, context } = options;
  const most = ASSISTANT_CLARIFICATION_MAX_CANDIDATES;
  const candidates: Candidate[] = [];
  const held = new Set<string>();
  const hold = (ref: EntityRef): boolean => {
    const name = JSON.stringify([ref.sourceId, ref.entityType, ref.stableId]);
    if (held.has(name)) return false;
    held.add(name);
    return true;
  };
  for (const key of context?.recent ?? []) {
    const ref = context?.keys.get(key);
    const shown = context?.shown.get(key);
    if (ref === undefined || shown === undefined || ref.entityType !== entityType || !hold(ref) || candidates.length >= most) continue;
    candidates.push({ ref, ...shown });
  }
  if (candidates.length >= most) return candidates;
  const unseen = options.viewEntities.filter((ref) => ref.entityType === entityType && hold(ref)).slice(0, most);
  if (unseen.length === 0) return candidates;
  const reading = await options.read({ entities: unseen, edges: [], aggregates: [], derived: [] });
  for (const ref of unseen) {
    const node = reading.nodes.find((held) => held.ref.sourceId === ref.sourceId && held.ref.entityType === ref.entityType && held.ref.stableId === ref.stableId);
    if (node !== undefined && candidates.length < most) candidates.push({ ref, title: node.display.title, type: node.display.type });
  }
  return candidates;
}

/** The answer of a turn that asks which element is meant: the question naming the entity type and each candidate as the analyst sees it, with the choice the panel sends when it is picked, never a reference. */
export const clarificationAnswer = (candidates: readonly Candidate[], choiceOf: (candidate: Candidate) => AssistantChoice): AssistantTurnAnswer => ({
  status: 'clarification',
  question: assistantClarificationQuestion(candidates[0]?.type ?? ''),
  candidates: candidates.map((candidate) => ({ title: candidate.title, type: candidate.type, choice: choiceOf(candidate) })),
});
