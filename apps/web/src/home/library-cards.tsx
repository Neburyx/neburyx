import { useRecentState } from './recent-context.js';
import { LIBRARY_COPY } from './copy.js';
import { utcClock } from './relative-time.js';

export function LibraryCards() {
  const { list } = useRecentState();
  const counts = list.phase === 'ready' || list.phase === 'loading' ? list.data?.counts : undefined;
  const unanswered = <p className="library-note">{list.phase === 'failed' ? LIBRARY_COPY.notRead : LIBRARY_COPY.loading}</p>;
  return (
    <div role="group" aria-label={LIBRARY_COPY.label} className="library-cards">
      <div className="library-card">
        <h3>{LIBRARY_COPY.investigations}</h3>
        {counts === undefined ? (
          unanswered
        ) : (
          <>
            <p className="library-figure">{counts.investigations.value}</p>
            <p className="library-note">{LIBRARY_COPY.acrossSources(counts.sources.value)}</p>
          </>
        )}
      </div>
      <div className="library-card">
        <h3>{LIBRARY_COPY.savedViews}</h3>
        {counts === undefined ? (
          unanswered
        ) : (
          <>
            <p className="library-figure">{counts.savedViews.count.value}</p>
            {counts.savedViews.lastEditedAt === null ? null : <p className="library-note">{LIBRARY_COPY.lastEdited(utcClock(counts.savedViews.lastEditedAt))}</p>}
          </>
        )}
      </div>
      <div className="library-card">
        <h3>{LIBRARY_COPY.patterns}</h3>
        <p className="library-note">{LIBRARY_COPY.noPatterns}</p>
      </div>
    </div>
  );
}
