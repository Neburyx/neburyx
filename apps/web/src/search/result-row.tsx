import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { SEARCH_COPY } from './copy.js';
import { summaryOf } from './hit-summary.js';
import { useFocusOnMount } from './show-more.js';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

/** `focus` asks for the row to take the focus when it is first drawn: the first hit of a page that Show more added. */
export function ResultRow({ node, type, busy, context, relationship, focus = false, onOpen }: { readonly node: GraphNode; readonly type: EntityTypeProfile | undefined; readonly busy: boolean; readonly context?: string; readonly relationship?: string; readonly focus?: boolean; readonly onOpen: (node: GraphNode) => void }) {
  const summary = summaryOf(node, type).join(' · ');
  const row = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li className="search-hit" ref={row} {...(focus ? { tabIndex: -1 } : {})}>
      <div className="search-hit-text">
        <span className="search-hit-type">{type?.displayName ?? node.display.type}</span>
        <strong>{node.display.title}</strong>
        {summary === '' ? null : <span className="search-hit-summary">{summary}</span>}
        {relationship === undefined ? null : <span className="search-hit-relationship">{relationship}</span>}
        {context === undefined ? null : <span className="search-hit-context">{context}</span>}
      </div>
      <button type="button" className="link" aria-label={`${SEARCH_COPY.openInGraph}: ${node.display.title}`} aria-disabled={busy} onClick={() => onOpen(node)}>
        {SEARCH_COPY.openInGraph}
      </button>
    </li>
  );
}
