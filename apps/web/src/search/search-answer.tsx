import type { GraphNode, SearchResult, SourceProfile } from '@neburyx/contracts';
import { countText, evidenceText, matchesText, relatedText, secondsText } from './count-label.js';
import { FILTERS_COPY, groupFailedText, groupNotReadSummary, hiddenBySelection, referencesLine, RETRY, SEARCH_COPY, showingResultsFor } from './copy.js';
import { EvidenceNotes, EvidenceSection } from './evidence-section.js';
import { ResultRow } from './result-row.js';
import { statesOf } from './states.js';

export interface AnswerProps {
  readonly result: SearchResult;
  readonly answeredText: string;
  readonly currentText: string;
  readonly profile: SourceProfile;
  readonly busy: boolean;
  readonly mask: boolean;
  readonly onOpen: (node: GraphNode) => void;
  readonly onRetry: () => void;
  /** Clears the selection of the Filters, offered where the page says there is no result for it. */
  readonly onReset: () => void;
}

export function SearchAnswer({ result, answeredText, currentText, profile, busy, mask, onOpen, onRetry, onReset }: AnswerProps) {
  const count = result.counts.exact;
  const typeOf = (entityType: string) => profile.entityTypes.find((type) => type.type === entityType);
  const states = statesOf(result, mask);
  const failureOf = (group: 'exact' | 'related' | 'evidence') => result.failures.find((failure) => failure.group === group);
  const exactFailure = failureOf('exact');
  const relatedFailure = failureOf('related');
  const evidenceFailure = failureOf('evidence');
  const failureLine = (failure: NonNullable<typeof exactFailure>) => (
    <p key={failure.group} role="alert" className="search-group-failure">
      {groupFailedText(failure.group, failure.code, failure.timeoutMs)}
    </p>
  );
  return (
    <>
      {answeredText === currentText ? null : <p className="search-labelled">{showingResultsFor(answeredText)}</p>}
      {result.searchable || result.related.searchable || result.evidence.searchable ? (
        <p className="search-summary">
          {[
            result.searchable ? (exactFailure === undefined ? matchesText(count) : groupNotReadSummary('exact')) : undefined,
            result.related.searchable ? (relatedFailure === undefined ? relatedText(result.related.count) : groupNotReadSummary('related')) : undefined,
            result.evidence.searchable ? (evidenceFailure === undefined ? evidenceText(result.evidence.count) : groupNotReadSummary('evidence')) : undefined,
            secondsText(result.elapsedMs),
          ]
            .filter((part) => part !== undefined)
            .join(' · ')}
        </p>
      ) : null}
      {result.related.hits.length === 0 ? null : <p className="search-note">{SEARCH_COPY.relatedNote}</p>}
      {result.disabledTypes.length === 0 ? null : (
        <ul className="search-notes">
          {result.disabledTypes.map((disabled) => (
            <li key={disabled.entityType}>
              {typeOf(disabled.entityType)?.displayName ?? disabled.entityType}: {SEARCH_COPY.disabledType}.
            </li>
          ))}
        </ul>
      )}
      {result.related.disabledTypes.length === 0 ? null : (
        <ul className="search-notes">
          {result.related.disabledTypes.map((disabled) => (
            <li key={disabled.entityType}>
              {typeOf(disabled.entityType)?.displayName ?? disabled.entityType}: {SEARCH_COPY.relatedDisabledType}.
            </li>
          ))}
        </ul>
      )}
      <EvidenceNotes group={result.evidence} profile={profile} />
      {result.warnings.length === 0 ? null : (
        <ul className="search-notes">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {states.hidden.map((group) => (
        <p key={group} className="search-note">
          {hiddenBySelection(group)}
        </p>
      ))}
      {states.reasons.map((reason) => (
        <p key={reason} className="search-nothing">
          {reason}
        </p>
      ))}
      {states.message === 'no-matches' ? (
        <div className="search-empty">
          <h2>{SEARCH_COPY.emptyTitle}</h2>
          <p>{SEARCH_COPY.emptyHint}</p>
        </div>
      ) : null}
      {states.message === 'unshown' ? (
        <div className="search-empty">
          <h2>{FILTERS_COPY.unshown}</h2>
        </div>
      ) : null}
      {states.message === 'no-result-for-selection' ? (
        <div className="search-empty">
          <h2>{FILTERS_COPY.noResultTitle}</h2>
          <p>{FILTERS_COPY.noResultHint}</p>
          <button type="button" className="link" onClick={onReset}>
            {FILTERS_COPY.reset}
          </button>
        </div>
      ) : null}
      {exactFailure === undefined ? null : failureLine(exactFailure)}
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
      {relatedFailure === undefined ? null : failureLine(relatedFailure)}
      {result.related.hits.length === 0 ? null : (
        <section aria-labelledby="search-related-title">
          <h2 id="search-related-title">
            {SEARCH_COPY.relatedTitle} ({countText(result.related.count)})
          </h2>
          <ul className="search-hits">
            {result.related.hits.map(({ node, matchedProperties }) => (
              <ResultRow key={`${node.ref.entityType}/${node.ref.stableId}`} node={node} type={typeOf(node.ref.entityType)} busy={busy} context={referencesLine(answeredText, matchedProperties)} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
      {evidenceFailure === undefined ? null : failureLine(evidenceFailure)}
      <EvidenceSection group={result.evidence} profile={profile} />
      {result.failures.length === 0 ? null : (
        <button type="button" className="link search-retry" onClick={onRetry}>
          {RETRY}
        </button>
      )}
    </>
  );
}
