import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { MAX_SEARCH_TEXT_LENGTH, MIN_SEARCH_TEXT_LENGTH, type SourceProfile, type SourceSummary } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { useRequest } from '../api/use-request.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { SearchEvidenceHost } from '../evidence/search-host.js';
import { PageHeading } from '../shell/page-heading.js';
import { useSessionMask } from '../state/context.js';
import { captionOf, SEARCH_COPY, TOO_LONG } from './copy.js';
import { focusSearchRequested } from './search-shortcut.js';
import { SearchResults } from './search-results.js';
import { addressOf, NO_SELECTION, selectionOf, type Selection } from './selection.js';
import { useOpenResult } from './use-open-result.js';

const codePoints = (text: string): number => Array.from(text).length;

/** What a change of source leaves in the history entry it makes, so the page that follows puts the focus back on the selector. */
const FOCUS_SOURCE = { focusSource: true } as const;

function focusIsOnSource(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'focusSource' in state && state.focusSource === true;
}

export interface WorkspaceProps {
  readonly client: ApiClient;
  readonly source: SourceSummary;
  /** Every configured source: a person who has more than one chooses which to search. */
  readonly sources: readonly SourceSummary[];
  readonly principalId: string;
  readonly text: string;
}

/** The page for one source: its heading, the search box and the results; the profile of the source is read here and nothing is searched until it has been. */
export function SearchWorkspace({ client, source, sources, principalId, text }: WorkspaceProps) {
  const [params, setParams] = useSearchParams();
  const mask = useSessionMask();
  const selector = useRef<HTMLSelectElement>(null);
  const location = useLocation();
  const comesFromSelector = focusIsOnSource(location.state);
  const box = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [repeats, setRepeats] = useState(0);
  const loadProfile = useCallback(
    async (signal: AbortSignal): Promise<ApiResult<SourceProfile>> => {
      const result = await client.getProfile(source.id, signal);
      return result.ok && result.value.sourceId !== source.id ? { ok: false, failure: { code: 'SCHEMA_MISMATCH' } } : result;
    },
    [client, source.id],
  );
  const profile = useRequest(loadProfile);
  const profileData = profile.state.phase === 'ready' || profile.state.phase === 'loading' ? profile.state.data : undefined;
  const profileFailure = profile.state.phase === 'failed' || profile.state.phase === 'ready' ? profile.state.failure : undefined;
  const { open, busy, refusal } = useOpenResult(client, principalId);
  const address = params.toString();
  // one object for one address, so a search is not sent again because the page was drawn again
  const selection = useMemo(() => (profileData === undefined ? NO_SELECTION : selectionOf(new URLSearchParams(address), profileData)), [address, profileData]);

  useEffect(() => {
    if (comesFromSelector) selector.current?.focus();
  }, [comesFromSelector]);

  useEffect(() => {
    if (!focusSearchRequested(location.state)) return;
    box.current?.focus();
    box.current?.select();
  }, [location.key, location.state]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get('q');
    const entered = typeof typed === 'string' ? typed : '';
    if (codePoints(entered.trim()) < MIN_SEARCH_TEXT_LENGTH) return setNotice(SEARCH_COPY.tooShort);
    if (codePoints(entered) > MAX_SEARCH_TEXT_LENGTH) return setNotice(TOO_LONG);
    setNotice(undefined);
    if (entered === text) return setRepeats((count) => count + 1);
    setParams(addressOf(source.id, selection), { state: { q: entered } });
  };

  const select = (chosen: Selection): void => {
    setNotice(undefined);
    setParams(addressOf(source.id, chosen), { state: { q: text } });
  };

  const changeSource = (event: ChangeEvent<HTMLSelectElement>): void => {
    setParams({ source: event.target.value }, { state: { ...FOCUS_SOURCE, ...(codePoints(text) >= MIN_SEARCH_TEXT_LENGTH ? { q: text } : {}) } });
  };

  return (
    <section className="search-page">
      <PageHeading title={SEARCH_COPY.title} description={SEARCH_COPY.description} source={{ alias: source.alias, synthetic: source.synthetic }} />
      <form key={`${source.id}\u0000${text}`} className="search-form" role="search" onSubmit={submit}>
        {sources.length < 2 ? null : (
          <select ref={selector} aria-label={SEARCH_COPY.sourceLabel} value={source.id} onChange={changeSource}>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.alias}
              </option>
            ))}
          </select>
        )}
        <input ref={box} type="search" name="q" aria-label={SEARCH_COPY.searchLabel} defaultValue={text} autoComplete="off" />
        <button type="submit" className="primary">
          {SEARCH_COPY.searchButton}
        </button>
      </form>
      <p className="search-caption" aria-live="polite">
        {captionOf(source.alias)}
      </p>
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {refusal === undefined ? null : (
        <div role="group" aria-label="Opening failed">
          <FailureNotice failure={refusal.failure} />
        </div>
      )}
      {profileData === undefined ? (
        profileFailure === undefined ? (
          <p role="status">{SEARCH_COPY.loadingSources}</p>
        ) : (
          <div className="search-failure">
            <p>{SEARCH_COPY.couldNotReadProfile}</p>
            <FailureNotice failure={profileFailure} />
            {canRetry(profileFailure) ? (
              <button type="button" className="secondary" onClick={profile.reload}>
                {SEARCH_COPY.tryAgain}
              </button>
            ) : null}
          </div>
        )
      ) : codePoints(text) < MIN_SEARCH_TEXT_LENGTH ? null : (
        <SearchEvidenceHost key={`${source.id}\u0000${mask}`} mask={mask}>
          <SearchResults key={`${source.id}\u0000${mask}`} client={client} source={source} principalId={principalId} profile={profileData} text={text} mask={mask} selection={selection} onSelect={select} busy={busy} repeats={repeats} onOpen={open} />
        </SearchEvidenceHost>
      )}
    </section>
  );
}
