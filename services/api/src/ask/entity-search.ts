import type { AskEntityMatches, AskEntitySearch } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { SearchService } from '../search/search-service.js';
import type { Principal } from '../seams/seams.js';

export interface AskSearchContext {
  readonly principal: Principal;
  readonly sourceId: string;
  readonly traceId: string;
  readonly mask: boolean;
}

/**
 * The exact search of one source for a typed text, as the Ask resolution of a question uses it: the same search service and gate as manual search, reading only the exact group. A failed read of that group fails the search with the failure's code; a hit with no stable
 * ID is counted and never returned as a reference.
 */
export function createAskEntitySearch(searching: Pick<SearchService, 'search'>, context: AskSearchContext): AskEntitySearch {
  return async ({ text }, signal): Promise<AskEntityMatches> => {
    const result = await searching.search({ ...context, text, matchModes: ['exact'], signal });
    const failure = result.failures.find((entry) => entry.group === 'exact');
    if (failure !== undefined) throw new AppError(failure.code);
    return { refs: result.exactMatches.map((match) => match.ref), unreferenced: result.exactUnreferenced?.length ?? 0, count: result.counts.exact };
  };
}
