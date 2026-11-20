import type { ElementRefs, SummaryReading } from '@neburyx/contracts';
import type { AssistantContextTurn } from './thread-store.js';

type EntityRef = AssistantContextTurn['entities'][number]['ref'];

export interface TurnContext {
  /** What the router is given of the thread: one line for each turn and one for each element it names by key. */
  readonly text: string;
  /** The reference of each key of this turn; a key that is not here names nothing. */
  readonly keys: ReadonlyMap<string, EntityRef>;
  /** What the analyst sees of the element of each key: its title as the masking of this message gives it, and its entity type's display name. */
  readonly shown: ReadonlyMap<string, { readonly title: string; readonly type: string }>;
  /** The keys, the elements of the last turn first, then those of the turns before it newest first, each key once. */
  readonly recent: readonly string[];
}

const canonical = (ref: EntityRef): string => JSON.stringify([ref.sourceId, ref.entityType, ref.stableId]);
const isEntity = (ref: object): ref is EntityRef => 'entityType' in ref;

function refsOf(turn: AssistantContextTurn, sourceId: string): readonly EntityRef[] {
  const cited = turn.citationRefs.filter(isEntity);
  return [...turn.entities.map((entity) => entity.ref), ...cited].filter((ref) => ref.sourceId === sourceId);
}

function lineOf(turn: AssistantContextTurn, keyOf: (ref: EntityRef) => string | undefined): string {
  const head = turn.route === 'refuse' ? 'refused' : turn.route === 'view' ? 'view' : `ask "${turn.intent ?? ''}"`;
  if (turn.outcome === 'refused') return `${head}${turn.cause === undefined ? '' : ` (${turn.cause})`}${turn.route === 'refuse' ? '' : ' refused'}`;
  const roles = turn.entities.flatMap((entity) => {
    const key = keyOf(entity.ref);
    return key === undefined ? [] : [`${entity.role} = ${key}`];
  });
  const cited = [...new Set(turn.citationRefs.filter(isEntity).flatMap((ref) => keyOf(ref) ?? []))];
  return [head, roles.length === 0 ? undefined : `ran for ${roles.join(', ')}`, cited.length === 0 ? undefined : `cited ${cited.join(', ')}`].filter((part) => part !== undefined).join('; ');
}

/**
 * What the router is given of the last turns of the person's thread: each turn as its route, its intent, the elements it ran for each role and the elements it cited, and each element as a key of this turn and its title as the analyst sees it.
 * The elements are read again through the gate for this message, so masking and access are as of now, and an element the gate does not give back has no key. Absent when the thread has no turn.
 */
export async function buildContext(options: { readonly turns: readonly AssistantContextTurn[]; readonly sourceId: string; readonly read: (refs: ElementRefs) => Promise<SummaryReading> }): Promise<TurnContext | undefined> {
  const { turns, sourceId } = options;
  if (turns.length === 0) return undefined;
  const wanted = new Map<string, EntityRef>();
  for (const turn of turns) for (const ref of refsOf(turn, sourceId)) wanted.set(canonical(ref), ref);
  const titles = new Map<string, { readonly title: string; readonly type: string }>();
  if (wanted.size > 0) {
    const reading = await options.read({ entities: [...wanted.values()], edges: [], aggregates: [], derived: [] });
    for (const node of reading.nodes) if (wanted.has(canonical(node.ref))) titles.set(canonical(node.ref), { title: node.display.title, type: node.display.type });
  }
  const keys = new Map<string, EntityRef>();
  const keyByRef = new Map<string, string>();
  const keyOf = (ref: EntityRef): string | undefined => keyByRef.get(canonical(ref));
  for (const [name, ref] of wanted) {
    if (!titles.has(name)) continue;
    const key = `c${keys.size + 1}`;
    keys.set(key, ref);
    keyByRef.set(name, key);
  }
  const recent = [...new Set(turns.toReversed().flatMap((turn) => refsOf(turn, sourceId).flatMap((ref) => keyOf(ref) ?? [])))];
  const shown = new Map([...keys].map(([key, ref]) => [key, titles.get(canonical(ref)) ?? { title: '', type: '' }]));
  const lines = turns.map((turn, index) => `${index + 1}. ${lineOf(turn, keyOf)}`);
  const elements = [...keys].map(([key, ref]) => {
    const shown = titles.get(canonical(ref));
    return `${key} | ${JSON.stringify(shown?.title ?? '')} | ${JSON.stringify(shown?.type ?? '')}`;
  });
  const text = ['Earlier turns of this thread, oldest first:', ...lines, ...(elements.length === 0 ? [] : ['', 'Elements of those turns, by key | title | type:', ...elements])].join('\n');
  return { text, keys, shown, recent };
}
