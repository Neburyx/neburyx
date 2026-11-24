import type { SourceProfile } from '@neburyx/contracts';
import { useVisibleGraph, useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { isNotReadNode, isUnmappedNode } from '../draft/unmapped.js';
import { countWords } from './words.js';

export interface Suggestion {
  /** What the button or example shows: a long title is cut with an ellipsis. */
  readonly label: string;
  /** What is sent when it is pressed, and what a tooltip and an accessible name hold. */
  readonly question: string;
}

export const SUGGESTION_TITLE_MAX = 60;

const WHAT_AM_I_LOOKING_AT = 'What am I looking at?';
const SUMMARIZE = 'Summarize what is on screen';

const fixed = (text: string): Suggestion => ({ label: text, question: text });

function cut(title: string): string {
  const characters = [...title];
  return characters.length <= SUGGESTION_TITLE_MAX ? title : `${characters.slice(0, SUGGESTION_TITLE_MAX - 1).join('')}…`;
}

interface Start {
  readonly entityType: string;
  readonly stableId: string;
}

function titleOf(graph: LoadedGraph, start: Start | null | undefined): string | undefined {
  const usable = graph.nodes.filter((node) => !isNotReadNode(node) && !isUnmappedNode(node) && node.display.title.trim() !== '');
  const own = start === null || start === undefined ? undefined : usable.find((node) => node.ref.entityType === start.entityType && node.ref.stableId === start.stableId);
  return (own ?? usable[0])?.display.title;
}

/** Two fixed questions and one built from the view or the source profile: the title of an entity on screen, else the display name of the investigation's entity type, else none. Nothing here names a domain. */
export function suggestionsOf(graph: LoadedGraph, profile: SourceProfile | undefined, start: Start | null | undefined, wordLimit?: number): readonly Suggestion[] {
  const fits = (question: string): boolean => wordLimit === undefined || countWords(question) <= wordLimit;
  const title = titleOf(graph, start);
  const typeName = start === null || start === undefined ? undefined : profile?.entityTypes.find((entry) => entry.type === start.entityType)?.displayName;
  const candidates: Suggestion[] = [];
  if (title !== undefined) candidates.push({ label: `What is connected to ${cut(title)}?`, question: `What is connected to ${title}?` });
  if (typeName !== undefined) candidates.push(fixed(`What can I ask about this ${typeName}?`));
  const built = candidates.find((candidate) => fits(candidate.question));
  return [fixed(WHAT_AM_I_LOOKING_AT), fixed(SUMMARIZE), ...(built === undefined ? [] : [built])];
}

export function useSuggestions(wordLimit?: number): readonly Suggestion[] {
  const graph = useVisibleGraph();
  const profile = useProfileWhenProvided();
  const state = useClientState();
  const start = useStoreSelector(state.investigation, (investigation) => investigation.record?.startingEntity);
  return suggestionsOf(graph, profile, start, wordLimit);
}
