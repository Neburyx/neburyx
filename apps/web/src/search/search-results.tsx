import { useCallback, useEffect, useRef } from 'react';
import type { GraphNode, SearchResult, SourceProfile, SourceSummary } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { useRequest } from '../api/use-request.js';
import type { QueryKey } from '../state/keys.js';
import { SEARCH_COPY } from './copy.js';
import { searchKeyOf } from './search-key.js';
import { SearchAnswer } from './search-answer.js';
import { SearchFailure } from './search-failure.js';

interface Searched {
  readonly key: QueryKey;
  readonly text: string;
  readonly result: SearchResult;
}

export interface SearchResultsProps {
  readonly client: ApiClient;
  readonly source: SourceSummary;
  readonly principalId: string;
  readonly profile: SourceProfile;
  readonly text: string;
  readonly mask: boolean;
  readonly busy: boolean;
  /** How many times the text already searched was submitted again: each one sends the search again, and the earlier answer stays until the new one arrives. */
  readonly repeats: number;
  readonly onOpen: (node: GraphNode) => void;
}

/** One search of one source with one mask: the page gives this component a new identity when the source or the mask changes, so nothing of an earlier source or mask is kept. */
export function SearchResults({ client, source, principalId, profile, text, mask, busy, repeats, onOpen }: SearchResultsProps) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<ApiResult<Searched>> => {
      const result = await client.searchEntities({ sourceId: source.id, text, ...(mask ? { mask: true } : {}) }, signal);
      return result.ok ? { ok: true, value: { key: searchKeyOf({ sourceId: source.id, principalId, text, mask }), text, result: result.value } } : result;
    },
    [client, source.id, principalId, text, mask],
  );
  const { state, reload } = useRequest(load);
  const region = useRef<HTMLDivElement>(null);
  const seenRepeats = useRef(repeats);
  useEffect(() => {
    if (seenRepeats.current === repeats) return;
    seenRepeats.current = repeats;
    reload();
  }, [repeats, reload]);
  const retry = (): void => {
    region.current?.focus();
    reload();
  };
  const answered = state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
  const failure = state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
  const shown = answered !== undefined && answered.key.sourceId === source.id && answered.key.mask === mask ? answered : undefined;
  return (
    <div ref={region} tabIndex={-1} className="search-results" aria-busy={state.phase === 'loading'}>
      {state.phase === 'loading' ? <p role="status">{SEARCH_COPY.searching}</p> : null}
      {failure === undefined ? null : <SearchFailure failure={failure} sourceId={source.id} onRetry={retry} />}
      {shown === undefined ? null : <SearchAnswer result={shown.result} answeredText={shown.text} currentText={text} profile={profile} busy={busy} mask={mask} onOpen={onOpen} onRetry={retry} />}
    </div>
  );
}
