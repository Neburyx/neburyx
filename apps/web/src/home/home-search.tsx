import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { SourceSummary } from '@neburyx/contracts';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { captionOf, SEARCH_COPY } from '../search/copy.js';
import { chooseSearchSource } from '../search/search-source.js';
import { searchTextProblem } from '../search/search-text.js';
import { SEARCH_PATH, SEARCH_BINDING_ID } from '../search/search-shortcut.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useKeyBindings } from '../workspace/key-binding-registry.js';
import { SEARCH_PLACEHOLDER } from './copy.js';

function SearchForm({ sources }: { readonly sources: readonly SourceSummary[] }) {
  const navigate = useNavigate();
  const lastOpenedId = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  const hint = useKeyBindings().find((binding) => binding.id === SEARCH_BINDING_ID)?.shown[0];
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const choice = chooseSearchSource(sources, null, lastOpenedId);
  const source = choice.kind === 'chosen' ? (sources.find((item) => item.id === chosen) ?? choice.source) : undefined;
  if (source === undefined) return <p role="status">{SEARCH_COPY.noSource}</p>;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = new FormData(event.currentTarget).get('q');
    const entered = typeof typed === 'string' ? typed : '';
    const wrong = searchTextProblem(entered);
    setProblem(wrong);
    if (wrong === undefined) navigate({ pathname: SEARCH_PATH, search: new URLSearchParams({ source: source.id }).toString() }, { state: { q: entered } });
  };

  return (
    <div className="home-search">
      <form className="search-form" role="search" onSubmit={submit}>
        {sources.length < 2 ? null : (
          <select aria-label={SEARCH_COPY.sourceLabel} value={source.id} onChange={(event) => setChosen(event.target.value)}>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.alias}
              </option>
            ))}
          </select>
        )}
        <input type="search" name="q" aria-label={SEARCH_COPY.searchLabel} placeholder={SEARCH_PLACEHOLDER} autoComplete="off" />
        {hint === undefined ? null : <kbd className="home-search-hint">{hint}</kbd>}
        <button type="submit" className="primary">
          {SEARCH_COPY.searchButton}
        </button>
      </form>
      <p className="search-caption" aria-live="polite">
        {captionOf(source.alias)}
      </p>
      {problem === undefined ? null : <p role="status">{problem}</p>}
    </div>
  );
}

export function HomeSearch() {
  const shell = useShellData();
  const sources = answeredData(shell.sources);
  const identity = answeredData(shell.me);
  if (sources === undefined || identity === undefined) {
    const failure = sources === undefined ? retainedFailure(shell.sources) : retainedFailure(shell.me);
    if (failure === undefined) return <p role="status">{SEARCH_COPY.loadingSources}</p>;
    return (
      <div className="search-failure">
        <p>{SEARCH_COPY.couldNotReadSources}</p>
        <FailureNotice failure={failure} />
        {canRetry(failure) ? (
          <button type="button" className="secondary" onClick={sources === undefined ? shell.reloadSources : shell.reload}>
            {SEARCH_COPY.tryAgain}
          </button>
        ) : null}
      </div>
    );
  }
  return <SearchForm sources={sources.items} />;
}
