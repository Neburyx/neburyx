import { useId } from 'react';
import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { SEARCH_COPY } from './copy.js';
import { summaryOf } from './hit-summary.js';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

export function ResultRow({ node, type, busy, onOpen }: { readonly node: GraphNode; readonly type: EntityTypeProfile | undefined; readonly busy: boolean; readonly onOpen: (node: GraphNode) => void }) {
  const titleId = useId();
  const summary = summaryOf(node, type).join(' · ');
  return (
    <li className="search-hit">
      <div className="search-hit-text">
        <span className="search-hit-type">{type?.displayName ?? node.display.type}</span>
        <strong id={titleId}>{node.display.title}</strong>
        {summary === '' ? null : <span className="search-hit-summary">{summary}</span>}
      </div>
      <button type="button" aria-describedby={titleId} aria-disabled={busy} onClick={() => onOpen(node)}>
        {SEARCH_COPY.openInGraph}
      </button>
    </li>
  );
}
