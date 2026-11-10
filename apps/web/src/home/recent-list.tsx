import type { SourceProfile } from '@neburyx/contracts';
import type { RequestState } from '../api/use-request.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { HOME_COPY, MORE_THAN_SHOWN } from './copy.js';
import { useRecent, useRecentState } from './recent-context.js';
import { HomeEmptyState } from './home-empty-state.js';
import { RecentRow } from './recent-row.js';

// a profile whose last read failed is not used, so the row falls back to what is stored; one that is being read again is kept until its answer
function usableProfile(state: RequestState<SourceProfile> | undefined): SourceProfile | undefined {
  if (state === undefined) return undefined;
  if (state.phase === 'loading') return state.data;
  return state.phase === 'ready' && state.failure === undefined ? state.data : undefined;
}

export function RecentList() {
  const recent = useRecent();
  const { list: state, profiles } = useRecentState();
  const sources = answeredData(useShellData().sources)?.items;
  const now = Date.now();

  const data = state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
  const failure = state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;

  return (
    <section className="recent" aria-labelledby="recent-title">
      <h2 id="recent-title">{HOME_COPY.recentTitle}</h2>
      {data === undefined ? (
        failure === undefined ? (
          <p role="status">{HOME_COPY.loading}</p>
        ) : (
          <div className="recent-failure">
            <p>{HOME_COPY.couldNotRead}</p>
            <FailureNotice failure={failure} />
            {canRetry(failure) ? (
              <button type="button" className="secondary" onClick={recent.reload}>
                {HOME_COPY.tryAgain}
              </button>
            ) : null}
          </div>
        )
      ) : (
        <>
          {state.phase === 'loading' ? <p role="status">{HOME_COPY.loading}</p> : null}
          {failure === undefined ? null : (
            <div className="recent-failure">
              <FailureNotice failure={failure} />
              {canRetry(failure) ? (
                <button type="button" className="secondary" onClick={recent.reload}>
                  {HOME_COPY.tryAgain}
                </button>
              ) : null}
            </div>
          )}
          {data.items.length === 0 ? (
            <HomeEmptyState />
          ) : (
            <>
              <ul className="recent-rows">
                {data.items.map((item) => (
                  <RecentRow key={item.id} item={item} now={now} source={sources?.find((candidate) => candidate.id === item.sourceId)} profile={usableProfile(profiles.get(item.sourceId))} />
                ))}
              </ul>
            </>
          )}
          {data.hasMore ? <p className="recent-more">{MORE_THAN_SHOWN}</p> : null}
        </>
      )}
    </section>
  );
}
