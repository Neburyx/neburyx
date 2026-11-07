import type { Selection } from './selection.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, queryKeyText, type QueryKey } from '../state/keys.js';

export interface SearchIdentity {
  readonly sourceId: string;
  readonly principalId: string;
  readonly text: string;
  readonly mask: boolean;
  readonly selection: Selection;
}

/** What a search is: the source, the person, the text, the selection of entity types and match modes and whether personal data is masked, so an answer is never taken for another search's. */
export function searchKeyOf(search: SearchIdentity): QueryKey {
  return {
    sourceId: search.sourceId,
    principalId: search.principalId,
    policyVersion: DEFAULT_POLICY_VERSION,
    filterHash: DEFAULT_FILTER_HASH,
    params: JSON.stringify(['search', search.text, search.selection.entityTypes, search.selection.matchModes]),
    mask: search.mask,
  };
}

export const searchKeyText = (search: SearchIdentity): string => queryKeyText(searchKeyOf(search));
