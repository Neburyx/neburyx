import { SEARCH_MATCH_MODES, type SearchMatchMode, type SourceProfile } from '@neburyx/contracts';

/** What a person chose in the Filters of the Search results page: entity types of the source and match modes, in the order of the profile and of the modes, each once; empty when a list does not narrow. */
export interface Selection {
  readonly entityTypes: readonly string[];
  readonly matchModes: readonly SearchMatchMode[];
}

export const NO_SELECTION: Selection = { entityTypes: [], matchModes: [] };

export const sameSelection = (first: Selection, second: Selection): boolean => JSON.stringify([first.entityTypes, first.matchModes]) === JSON.stringify([second.entityTypes, second.matchModes]);

export const isNarrowed = (selection: Selection): boolean => selection.entityTypes.length > 0 || selection.matchModes.length > 0;

/** The selection an address holds: `type=` names an entity type of the profile and `mode=` a match mode; a name that is neither is ignored, and a name given twice counts once. */
export function selectionOf(params: URLSearchParams, profile: SourceProfile): Selection {
  const types = params.getAll('type');
  const modes = params.getAll('mode');
  return {
    entityTypes: profile.entityTypes.map((entity) => entity.type).filter((type) => types.includes(type)),
    matchModes: SEARCH_MATCH_MODES.filter((mode) => modes.includes(mode)),
  };
}

/** The address of a search of a source with a selection: the source, then the types, then the modes. Names only; the typed text is never in it. */
export function addressOf(sourceId: string, selection: Selection): URLSearchParams {
  const params = new URLSearchParams({ source: sourceId });
  for (const type of selection.entityTypes) params.append('type', type);
  for (const mode of selection.matchModes) params.append('mode', mode);
  return params;
}

/** The fields a request carries for a selection: none for a list that does not narrow, never an empty list. */
export function requestFieldsOf(selection: Selection): { readonly entityTypes?: string[]; readonly matchModes?: SearchMatchMode[] } {
  return {
    ...(selection.entityTypes.length === 0 ? {} : { entityTypes: [...selection.entityTypes] }),
    ...(selection.matchModes.length === 0 ? {} : { matchModes: [...selection.matchModes] }),
  };
}

/** The selection with one name chosen or not chosen, put back in the order of the profile and of the modes. */
export function withEntityType(selection: Selection, profile: SourceProfile, type: string, chosen: boolean): Selection {
  const kept = selection.entityTypes.filter((name) => name !== type);
  const types = chosen ? [...kept, type] : kept;
  return { ...selection, entityTypes: profile.entityTypes.map((entity) => entity.type).filter((name) => types.includes(name)) };
}

export function withMatchMode(selection: Selection, mode: SearchMatchMode, chosen: boolean): Selection {
  const kept = selection.matchModes.filter((name) => name !== mode);
  const modes = chosen ? [...kept, mode] : kept;
  return { ...selection, matchModes: SEARCH_MATCH_MODES.filter((name) => modes.includes(name)) };
}
