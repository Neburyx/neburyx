import { useCallback, useEffect, useRef } from 'react';
import { relationshipsOf, type Facets, type GraphNode, type SearchResult, type SourceProfile, type SourceSummary } from '@neburyx/contracts';
import { evidenceRowsOf } from './evidence-section.js';
import type { ApiClient, ApiResult } from '../api/client.js';
import { useRequest } from '../api/use-request.js';
import type { QueryKey } from '../state/keys.js';
import { SEARCH_COPY } from './copy.js';
import { searchKeyOf, searchKeyText } from './search-key.js';
import { atLeastHeld } from './facets-held.js';
import { useMorePages } from './use-more-pages.js';
import { SearchAnswer } from './search-answer.js';
import { SearchFailure } from './search-failure.js';
import { FiltersPanel } from './filters-panel.js';
import { requestFieldsOf, sameSelection, type Selection } from './selection.js';

interface Searched {
  readonly key: QueryKey;
  readonly text: string;
  readonly selection: Selection;
  readonly result: SearchResult;
}

export interface SearchResultsProps {
  readonly client: ApiClient;
  readonly source: SourceSummary;
  readonly principalId: string;
  readonly profile: SourceProfile;
  readonly text: string;
  readonly mask: boolean;
  /** What is chosen in the Filters: part of what a search is, so an answer is never shown for another selection. */
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly busy: boolean;
  /** How many times the text already searched was submitted again: each one sends the search again, and the earlier answer stays until the new one arrives. */
  readonly repeats: number;
  readonly onOpen: (node: GraphNode) => void;
}

/** One search of one source with one mask: the page gives this component a new identity when the source or the mask changes, so nothing of an earlier source or mask is kept. */
export function SearchResults({ client, source, principalId, profile, text, mask, selection, onSelect, busy, repeats, onOpen }: SearchResultsProps) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<ApiResult<Searched>> => {
      const result = await client.searchEntities({ sourceId: source.id, text, ...(mask ? { mask: true } : {}), ...requestFieldsOf(selection) }, signal);
      return result.ok ? { ok: true, value: { key: searchKeyOf({ sourceId: source.id, principalId, text, mask, selection }), text, selection, result: result.value } } : result;
    },
    [client, source.id, principalId, text, mask, selection],
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
  const sameSearch = answered !== undefined && answered.key.sourceId === source.id && answered.key.mask === mask ? answered : undefined;
  // the rows are those of the search that is asked: an answer of another selection is never shown under this one, while an answer of earlier text is shown, labelled, as before
  const shown = sameSearch !== undefined && sameSelection(sameSearch.selection, selection) ? sameSearch : undefined;
  const counts = useRef<{ readonly text: string; readonly facets: Extract<Facets, { searchable: true }> } | undefined>(undefined);
  const latest = sameSearch?.result.facets;
  if (sameSearch !== undefined && latest !== undefined && latest.searchable && latest.total.quality !== 'unknown') counts.current = { text: sameSearch.text, facets: latest };
  const kept = counts.current?.text === sameSearch?.text ? counts.current?.facets : undefined;
  const asked = searchKeyText({ sourceId: source.id, principalId, text, mask, selection });
  const pages = useMorePages(
    client,
    shown === undefined ? undefined : { identity: searchKeyText({ sourceId: source.id, principalId, text: shown.text, mask, selection: shown.selection }), sourceId: source.id, text: shown.text, mask, entityTypes: shown.selection.entityTypes, result: shown.result },
    asked,
  );
  const held = {
    exact: [...(shown?.result.exact ?? []), ...pages.exact.more],
    related: [...(shown?.result.related.hits ?? []), ...pages.related.more].map((hit) => hit.node),
    evidence: relationshipsOf(evidenceRowsOf([...(shown?.result.evidence.hits ?? []), ...pages.evidence.more], false, undefined).map((row) => row.hit)),
    unreferenced: { exact: [...(shown?.result.exactUnreferenced ?? []), ...pages.exact.unreferenced], related: [...(shown?.result.related.unreferenced ?? []), ...pages.related.unreferenced] },
  };
  const panel = latest === undefined || !latest.searchable ? undefined : { facets: latest.total.quality === 'unknown' ? (kept ?? latest) : atLeastHeld(latest, held), counted: latest.total.quality !== 'unknown' };
  return (
    <div className={panel === undefined ? 'search-body' : 'search-body search-body-filtered'}>
      {panel === undefined ? null : <FiltersPanel facets={panel.facets} counted={panel.counted} selection={selection} profile={profile} loading={state.phase === 'loading'} onChange={onSelect} onRetry={retry} />}
      <div ref={region} tabIndex={-1} className="search-results" aria-busy={state.phase === 'loading'}>
        {state.phase === 'loading' ? <p role="status">{SEARCH_COPY.searching}</p> : null}
        {failure === undefined ? null : <SearchFailure failure={failure} sourceId={source.id} onRetry={retry} />}
        {shown === undefined ? null : <SearchAnswer result={shown.result} answeredText={shown.text} currentText={text} profile={profile} busy={busy} mask={mask} onOpen={onOpen} onRetry={retry} onReset={() => onSelect({ entityTypes: [], matchModes: [] })} pages={pages} />}
      </div>
    </div>
  );
}
