import { Navigate, useLocation, useSearchParams } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { SEARCH_COPY, unknownSourceText } from './copy.js';
import { searchTextOf } from './search-state.js';
import { chooseSearchSource } from './search-source.js';
import { SearchWorkspace } from './search-workspace.js';

function Notice({ children }: { readonly children: string }) {
  return (
    <section className="search-page">
      <PageHeading title={SEARCH_COPY.title} description={SEARCH_COPY.description} source={null} />
      <p role="status">{children}</p>
    </section>
  );
}

function Failure({ failure, message, retry }: { readonly failure: Parameters<typeof FailureNotice>[0]['failure']; readonly message: string; readonly retry: () => void }) {
  return (
    <section className="search-page">
      <PageHeading title={SEARCH_COPY.title} description={SEARCH_COPY.description} source={null} />
      <div className="search-failure">
        <p>{message}</p>
        <FailureNotice failure={failure} />
        <button type="button" className="secondary" onClick={retry}>
          {SEARCH_COPY.tryAgain}
        </button>
      </div>
    </section>
  );
}

/** `/search?source=<id>`, with the typed text in the state of the history entry and never in the address: the sources and the person are read first, then the source is chosen and the search page for it takes over. */
export function SearchPage({ client }: { readonly client: ApiClient }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const shell = useShellData();
  const lastOpenedId = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  const sources = answeredData(shell.sources);
  const principalId = answeredData(shell.me)?.principal.id;

  if (sources === undefined) {
    const failure = retainedFailure(shell.sources);
    return failure === undefined ? <Notice>{SEARCH_COPY.loadingSources}</Notice> : <Failure failure={failure} message={SEARCH_COPY.couldNotReadSources} retry={shell.reloadSources} />;
  }
  const choice = chooseSearchSource(sources.items, params.get('source'), lastOpenedId);
  if (choice.kind === 'none') return <Notice>{SEARCH_COPY.noSource}</Notice>;
  if (choice.kind === 'unknown') return <Notice>{unknownSourceText(choice.sourceId)}</Notice>;
  if (choice.completesUrl) return <Navigate replace state={location.state} to={{ search: new URLSearchParams({ source: choice.source.id }).toString() }} />;
  if (principalId === undefined) {
    const failure = retainedFailure(shell.me);
    return failure === undefined ? <Notice>{SEARCH_COPY.loadingSources}</Notice> : <Failure failure={failure} message={SEARCH_COPY.couldNotReadSources} retry={shell.reload} />;
  }
  return <SearchWorkspace key={choice.source.id} client={client} source={choice.source} sources={sources.items} principalId={principalId} text={searchTextOf(location.state)} />;
}
