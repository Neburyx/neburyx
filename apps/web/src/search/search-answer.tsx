import type { GraphNode, SearchResult, SourceProfile } from '@neburyx/contracts';
import { countText, matchesText, secondsText } from './count-label.js';
import { NO_SEARCH_PROPERTIES, NOTHING_SEARCHABLE_MASKED, SEARCH_COPY, showingResultsFor } from './copy.js';
import { ResultRow } from './result-row.js';

export interface AnswerProps {
  readonly result: SearchResult;
  readonly answeredText: string;
  readonly currentText: string;
  readonly profile: SourceProfile;
  readonly busy: boolean;
  readonly mask: boolean;
  readonly onOpen: (node: GraphNode) => void;
}

export function SearchAnswer({ result, answeredText, currentText, profile, busy, mask, onOpen }: AnswerProps) {
  const count = result.counts.exact;
  const typeOf = (entityType: string) => profile.entityTypes.find((type) => type.type === entityType);
  return (
    <>
      {answeredText === currentText ? null : <p className="search-labelled">{showingResultsFor(answeredText)}</p>}
      {result.searchable ? (
        <p className="search-summary">
          {matchesText(count)} · {secondsText(result.elapsedMs)}
        </p>
      ) : null}
      {result.disabledTypes.length === 0 ? null : (
        <ul className="search-notes">
          {result.disabledTypes.map((disabled) => (
            <li key={disabled.entityType}>
              {typeOf(disabled.entityType)?.displayName ?? disabled.entityType}: {SEARCH_COPY.disabledType}.
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length === 0 ? null : (
        <ul className="search-notes">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {!result.searchable && result.disabledTypes.length === 0 ? <p className="search-nothing">{mask ? NOTHING_SEARCHABLE_MASKED : NO_SEARCH_PROPERTIES}</p> : null}
      {result.searchable && result.exact.length === 0 ? (
        <div className="search-empty">
          <h2>{SEARCH_COPY.emptyTitle}</h2>
          <p>{SEARCH_COPY.emptyHint}</p>
        </div>
      ) : null}
      {result.exact.length === 0 ? null : (
        <section aria-labelledby="search-group-title">
          <h2 id="search-group-title">
            {SEARCH_COPY.groupTitle} ({countText(count)})
          </h2>
          <ul className="search-hits">
            {result.exact.map((node) => (
              <ResultRow key={`${node.ref.entityType}/${node.ref.stableId}`} node={node} type={typeOf(node.ref.entityType)} busy={busy} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
