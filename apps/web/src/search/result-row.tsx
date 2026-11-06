import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { SEARCH_COPY } from './copy.js';
import { summaryOf } from './hit-summary.js';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

export function ResultRow({ node, type, busy, context, onOpen }: { readonly node: GraphNode; readonly type: EntityTypeProfile | undefined; readonly busy: boolean; readonly context?: string; readonly onOpen: (node: GraphNode) => void }) {
  const summary = summaryOf(node, type).join(' · ');
  return (
    <li className="search-hit">
      <div className="search-hit-text">
        <span className="search-hit-type">{type?.displayName ?? node.display.type}</span>
        <strong>{node.display.title}</strong>
        {summary === '' ? null : <span className="search-hit-summary">{summary}</span>}
        {context === undefined ? null : <span className="search-hit-context">{context}</span>}
      </div>
      <button type="button" className="link" aria-label={`${SEARCH_COPY.openInGraph}: ${node.display.title}`} aria-disabled={busy} onClick={() => onOpen(node)}>
        {SEARCH_COPY.openInGraph}
      </button>
    </li>
  );
}
