import { SourceStatusText } from '../shell/source-status-text.js';
import { useCurrentSource } from '../shell/use-current-source.js';

export function HeaderSource() {
  const { current, showsSyntheticBadge } = useCurrentSource();
  if (current === undefined) return null;
  return (
    <>
      <section aria-label="Source" className="header-source">
        <SourceStatusText current={current} />
      </section>
      {showsSyntheticBadge ? <span className="header-badge">Synthetic data</span> : null}
    </>
  );
}
