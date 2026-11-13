import { Link } from 'react-router';
import { useRecentState } from './recent-context.js';
import { LIBRARY_COPY, PATTERN_CARD_COPY } from './copy.js';
import { useHomePatterns } from './home-patterns.js';
import { utcClock } from './relative-time.js';

export function LibraryCards() {
  const { list } = useRecentState();
  const patterns = useHomePatterns();
  const presets = patterns.kind === 'list' && (patterns.list.phase === 'ready' || patterns.list.phase === 'loading') ? patterns.list.data?.presets : undefined;
  const presetCount = presets?.length;
  const counts = list.phase === 'ready' || list.phase === 'loading' ? list.data?.counts : undefined;
  const unanswered = <p className="library-note">{list.phase === 'failed' ? LIBRARY_COPY.notRead : LIBRARY_COPY.loading}</p>;
  return (
    <div role="group" aria-label={LIBRARY_COPY.label} className="library-cards">
      <div className="library-card">
        <h3>
          <Link to="/investigations">{LIBRARY_COPY.investigations}</Link>
        </h3>
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
        <h3>
          <Link to="/investigations?tab=views">{LIBRARY_COPY.savedViews}</Link>
        </h3>
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
        {patterns.kind !== 'list' ? null : presetCount !== undefined ? (
          <>
            <p className="library-figure">{presetCount}</p>
            <p className="library-note">{presetCount === 0 ? PATTERN_CARD_COPY.noPatterns : LIBRARY_COPY.approvedPatterns}</p>
          </>
        ) : (
          <p className="library-note">{patterns.list.phase === 'failed' ? LIBRARY_COPY.notRead : LIBRARY_COPY.loading}</p>
        )}
      </div>
    </div>
  );
}
