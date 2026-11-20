import { ASSISTANT_VIEW_KEYS_MAX, type ElementRefs, type SummaryReading } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
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

type RelationshipRef = Exclude<AssistantContextTurn['citationRefs'][number], EntityRef>;

const canonical = (ref: EntityRef): string => JSON.stringify([ref.sourceId, ref.entityType, ref.stableId]);
const isEntity = (ref: object): ref is EntityRef => 'entityType' in ref;

/** The relationships the turns cited, newest turn first, each once and no more than a view may name: the references of an earlier turn, never anything it said. */
function relationshipsOf(turns: readonly AssistantContextTurn[], sourceId: string): readonly RelationshipRef[] {
  const seen = new Map<string, RelationshipRef>();
  for (const turn of turns.toReversed()) for (const ref of turn.citationRefs) if (!isEntity(ref) && ref.sourceId === sourceId && seen.size < ASSISTANT_VIEW_KEYS_MAX) seen.set(canonicalText(ref), ref);
  return [...seen.values()];
}

function refsOf(turn: AssistantContextTurn, sourceId: string): readonly EntityRef[] {
  const cited = turn.citationRefs.filter(isEntity);
  return [...turn.entities.map((entity) => entity.ref), ...cited].filter((ref) => ref.sourceId === sourceId);
}

function lineOf(turn: AssistantContextTurn, keyOf: (ref: EntityRef) => string | undefined): string {
  const head = turn.route === 'refuse' ? 'refused' : turn.route === 'view' ? 'view' : `ask "${turn.intent ?? ''}"`;
  if (turn.outcome === 'waiting') return `${head}; waiting for the analyst's confirmation, nothing was read for it`;
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
  const relationships = relationshipsOf(turns, sourceId);
  let readEdges: SummaryReading['edges'] = [];
  const nodesRead = new Map<string, { readonly title: string; readonly type: string }>();
  if (wanted.size > 0 || relationships.length > 0) {
    const reading = await options.read({ entities: [...wanted.values()], edges: relationships.filter((ref) => 'stableId' in ref) as ElementRefs['edges'], aggregates: relationships.filter((ref) => 'aggregate' in ref) as ElementRefs['aggregates'], derived: relationships.filter((ref) => 'derived' in ref) as ElementRefs['derived'] });
    for (const node of reading.nodes) {
      nodesRead.set(canonical(node.ref), { title: node.display.title, type: node.display.type });
      if (wanted.has(canonical(node.ref))) titles.set(canonical(node.ref), { title: node.display.title, type: node.display.type });
    }
    readEdges = reading.edges;
    // the two ends of a relationship are read through the gate too, as the person sees them under this message's masking; a relationship whose end the gate does not give back is left out
    const ends = new Map<string, EntityRef>();
    for (const edge of readEdges) for (const end of [edge.from, edge.to]) if (!nodesRead.has(canonical(end)) && ends.size < ASSISTANT_VIEW_KEYS_MAX) ends.set(canonical(end), end);
    if (ends.size > 0) {
      const more = await options.read({ entities: [...ends.values()], edges: [], aggregates: [], derived: [] });
      for (const node of more.nodes) nodesRead.set(canonical(node.ref), { title: node.display.title, type: node.display.type });
    }
    readEdges = readEdges.filter((edge) => nodesRead.has(canonical(edge.from)) && nodesRead.has(canonical(edge.to)));
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
  const endTitle = (ref: EntityRef): string => JSON.stringify((nodesRead.get(canonical(ref))?.title.trim() ?? '') === '' ? ref.stableId : (nodesRead.get(canonical(ref))?.title ?? ref.stableId));
  const edgeLines = readEdges.slice(0, ASSISTANT_VIEW_KEYS_MAX).map((edge) => `${JSON.stringify(edge.type)} | ${endTitle(edge.from)} → ${endTitle(edge.to)}`);
  const text = ['Earlier turns of this thread, oldest first:', ...lines, ...(elements.length === 0 ? [] : ['', 'Elements of those turns, by key | title | type:', ...elements]), ...(edgeLines.length === 0 ? [] : ['', 'Relationships those turns cited (not keyed, never cited), type | from → to:', ...edgeLines])].join('\n');
  return { text, keys, shown, recent };
}
