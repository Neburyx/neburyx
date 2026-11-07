import type { GraphNode, SearchResult, SourceProfile } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import { countText, evidenceText, matchesText, relatedText, secondsText } from './count-label.js';
import { FILTERS_COPY, groupFailedText, groupNotReadSummary, hiddenBySelection, notSearchedLines, referencesLine, RETRY, SEARCH_COPY, showingResultsFor } from './copy.js';
import { EvidenceNotes, EvidenceSection, evidenceRowsOf } from './evidence-section.js';
import { ResultRow } from './result-row.js';
import { ShowMore } from './show-more.js';
import { UnreferencedRow } from './unreferenced-row.js';
import { statesOf } from './states.js';
import type { MorePages } from './use-more-pages.js';

/** The hits of the first page and of the pages Show more added, each once: a record whose stable ID two source records share can come back on a later page. */
function uniqueBy<Hit>(hits: readonly Hit[], keyOf: (hit: Hit) => string): Hit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = keyOf(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  /** The later pages of the groups, which Show more reads. */
  readonly pages: MorePages;
}

export function SearchAnswer({ result, answeredText, currentText, profile, busy, mask, onOpen, onRetry, onReset, pages }: AnswerProps) {
  const count = pages.exact.count;
  const exact = uniqueBy([...result.exact, ...pages.exact.more], (node) => elementKey(node.ref));
  const related = uniqueBy([...result.related.hits, ...pages.related.more], (hit) => elementKey(hit.node.ref));
  const evidence = evidenceRowsOf([...result.evidence.hits, ...pages.evidence.more], pages.evidence.nextCursor !== undefined, pages.evidence.focusAt);
  const exactUnreferenced = [...(result.exactUnreferenced ?? []), ...pages.exact.unreferenced];
  const relatedUnreferenced = [...(result.related.unreferenced ?? []), ...pages.related.unreferenced];
  const more = { current: pages.current, onShowMore: pages.showMore, onSearchAgain: onRetry };
  const typeOf = (entityType: string) => profile.entityTypes.find((type) => type.type === entityType);
  const typeName = (entityType: string): string => typeOf(entityType)?.displayName ?? entityType;
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
            result.related.searchable ? (relatedFailure === undefined ? relatedText(pages.related.count) : groupNotReadSummary('related')) : undefined,
            result.evidence.searchable ? (evidenceFailure === undefined ? evidenceText(pages.evidence.count) : groupNotReadSummary('evidence')) : undefined,
            secondsText(result.elapsedMs),
          ]
            .filter((part) => part !== undefined)
            .join(' · ')}
        </p>
      ) : null}
      {result.related.hits.length + (result.related.unreferenced?.length ?? 0) === 0 ? null : <p className="search-note">{SEARCH_COPY.relatedNote}</p>}
      {(['exact', 'related'] as const).map((group) => {
        const lines = notSearchedLines(group === 'exact' ? result.disabledTypes : result.related.disabledTypes, (entityType) => typeOf(entityType)?.displayName ?? entityType, group);
        return lines.length === 0 ? null : (
          <ul className="search-notes" key={group}>
            {lines.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        );
      })}
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
      {exact.length + exactUnreferenced.length === 0 ? null : (
        <section aria-labelledby="search-group-title">
          <h2 id="search-group-title">
            {SEARCH_COPY.groupTitle} ({countText(count)})
          </h2>
          <ul className="search-hits">
            {exact.map((node, index) => (
              <ResultRow key={elementKey(node.ref)} node={node} type={typeOf(node.ref.entityType)} busy={busy} focus={index === pages.exact.focusAt} onOpen={onOpen} />
            ))}
            {exactUnreferenced.map((hit, index) => (
              // an unreferenced hit has no key of its own; its place in the group's list is stable, since pages are only appended
              <UnreferencedRow key={`unreferenced:${index}`} hit={hit} typeName={typeName(hit.entityType)} className="search-hit" focus={index === pages.exact.unreferencedFocusAt} />
            ))}
          </ul>
          <ShowMore group="exact" pages={pages.exact} {...more} />
        </section>
      )}
      {relatedFailure === undefined ? null : failureLine(relatedFailure)}
      {related.length + relatedUnreferenced.length === 0 ? null : (
        <section aria-labelledby="search-related-title">
          <h2 id="search-related-title">
            {SEARCH_COPY.relatedTitle} ({countText(pages.related.count)})
          </h2>
          <ul className="search-hits">
            {related.map(({ node, matchedProperties }, index) => (
              <ResultRow key={elementKey(node.ref)} node={node} type={typeOf(node.ref.entityType)} busy={busy} context={referencesLine(answeredText, matchedProperties)} focus={index === pages.related.focusAt} onOpen={onOpen} />
            ))}
            {relatedUnreferenced.map((hit, index) => (
              <UnreferencedRow key={`unreferenced:${index}`} hit={hit} typeName={typeName(hit.entityType)} className="search-hit" focus={index === pages.related.unreferencedFocusAt} />
            ))}
          </ul>
          <ShowMore group="related" pages={pages.related} {...more} />
        </section>
      )}
      {evidenceFailure === undefined ? null : failureLine(evidenceFailure)}
      <EvidenceSection rows={evidence} count={pages.evidence.count} profile={profile}>
        <ShowMore group="evidence" pages={pages.evidence} {...more} />
      </EvidenceSection>
      {result.failures.length === 0 ? null : (
        <button type="button" className="link search-retry" onClick={onRetry}>
          {RETRY}
        </button>
      )}
    </>
  );
}
