import type { SourceProfile } from '@neburyx/contracts';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { countWords } from './words.js';

export interface Suggestion {
  /** What the button or example shows. */
  readonly label: string;
  /** What is sent when it is pressed. */
  readonly question: string;
}

const SUMMARIZE = 'Summarize what is on screen';
const USEFUL = 'Is anything useful in the data?';

const fixed = (text: string): Suggestion => ({ label: text, question: text });

interface Start {
  readonly entityType: string;
  readonly stableId: string;
}

/** Three questions: one about the type of the investigation's own entity (the display name from the source profile), then two that name no domain. With no such type in the profile the first is left out. Nothing here names a domain. */
export function suggestionsOf(profile: SourceProfile | undefined, start: Start | null | undefined, wordLimit?: number): readonly Suggestion[] {
  const typeName = start === null || start === undefined ? undefined : profile?.entityTypes.find((entry) => entry.type === start.entityType)?.displayName;
  const connected = typeName === undefined ? undefined : fixed(`What is connected to this ${typeName}?`);
  const fits = (suggestion: Suggestion): boolean => wordLimit === undefined || countWords(suggestion.question) <= wordLimit;
  return [...(connected === undefined || !fits(connected) ? [] : [connected]), fixed(SUMMARIZE), fixed(USEFUL)];
}

export function useSuggestions(wordLimit?: number): readonly Suggestion[] {
  const profile = useProfileWhenProvided();
  const state = useClientState();
  const start = useStoreSelector(state.investigation, (investigation) => investigation.record?.startingEntity);
  return suggestionsOf(profile, start, wordLimit);
}
