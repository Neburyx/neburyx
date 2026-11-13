import { useEffect, useRef, type ReactNode } from 'react';
import type { Count, PatternRunOk } from '@neburyx/contracts';
import { formatNumber } from '../../workspace/scope-text.js';
import { addedText, noticeText } from '../copy.js';
import { MatchCard } from './match-card.js';
import { RUN_COPY, addAll, addThese, countedBy, estimatedBy, matchesWord, noCountBy, noMatchText, runFromAnother, showingFirst, showingHeading, showingPage, utcTime } from './run-copy.js';
import type { AddResult } from './use-add-matches.js';

interface Props {
  readonly answer: PatternRunOk;
  readonly at: Date;
  /** The index of the page, from 0, and the matches on the pages before it. */
  readonly page: number;
  readonly before: number;
  /** Whether a page follows the one shown: one kept after a Previous, or one the cursor of the answer reads. */
  readonly hasNext: boolean;
  readonly reading: boolean;
  readonly mask: boolean;
  /** The properties of an entity type that hold personal data, by the mapping. */
  readonly personal: (entityType: string) => readonly string[];
  readonly keyProperties: (entityType: string) => readonly string[];
  readonly startName: string;
  readonly typeName: string;
  readonly add: AddResult;
  readonly evidenceOpener: ((reference: string) => (() => void) | undefined) | undefined;
  /** The sentence of a refused page, shown with the page kept. */
  readonly notice: ReactNode;
  readonly saveLink: ReactNode;
  readonly onEdit: () => void;
  readonly onRunAnother: () => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

interface Summary {
  readonly headline: string;
  readonly chip: string | undefined;
  readonly line: string;
  readonly of: string | undefined;
}

/** The count as the answer labels it; a page after the first is worded "at least", since its count is the matches of that page and no total is known. */
function summaryOf(count: Count, returned: number, before: number, at: Date, page: number): Summary {
  const time = utcTime(at);
  const through = before + returned;
  if (page > 0) return { headline: `At least ${matchesWord(through)}`, chip: RUN_COPY.lowerBound, line: showingPage(before + 1, through), of: `at least ${formatNumber(through)}` };
  switch (count.quality) {
    case 'exact':
      return { headline: matchesWord(count.value ?? returned), chip: RUN_COPY.exact, line: countedBy(time), of: formatNumber(count.value ?? returned) };
    case 'estimated':
      return { headline: `About ${matchesWord(count.value ?? returned)}`, chip: RUN_COPY.estimated, line: estimatedBy(time), of: `about ${formatNumber(count.value ?? returned)}` };
    case 'lowerBound':
      return { headline: `At least ${matchesWord(count.value ?? returned)}`, chip: RUN_COPY.lowerBound, line: showingFirst(returned), of: `at least ${formatNumber(count.value ?? returned)}` };
    case 'unknown':
      return { headline: 'The number of matches is not known', chip: undefined, line: noCountBy(time), of: undefined };
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}

/** A page of a result: the count with its label, Add to graph for the page, a card for each match, and Previous and Next when the run has more pages. */
export function ResultScreen({ answer, at, page, before, hasNext, reading, mask, personal, keyProperties, startName, typeName, add, evidenceOpener, notice, saveLink, onEdit, onRunAnother, onPrevious, onNext }: Props) {
  const returned = answer.matches.length;
  const summary = summaryOf(answer.count, returned, before, at, page);
  const heading = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // the first page takes the focus at its summary; a page turn takes it to the heading of the list, so the first match is next in the order of Tab
    (page === 0 ? summaryRef : heading).current?.focus();
  }, [page]);
  const everything = { nodes: answer.nodes, edges: answer.edges };
  const allOnGraph = returned > 0 && add.onGraph(everything);
  const exactPage = page === 0 && answer.count.quality === 'exact';
  return (
    <>
      <div className="run-body">
        {notice}
        <div className="run-card run-summary" tabIndex={-1} ref={summaryRef}>
          <p className="run-count" role="status">
            <strong className="run-figure">{summary.headline}</strong>
            {summary.chip === undefined ? null : (
              <>
                <span aria-hidden="true"> · </span>
                <span className="run-quality">{summary.chip}</span>
              </>
            )}
          </p>
          <p>{returned === 0 && page === 0 ? noMatchText(startName) : summary.line}</p>
        </div>
        <p className="search-panel-note">{RUN_COPY.countsAlways}</p>
        {add.added === undefined ? null : (
          <p className="patterns-state" role="status">
            {addedText(add.added, answer.count)}
          </p>
        )}
        <div className="run-actions">
          {returned === 0 ? null : (
            <button type="button" className="primary" disabled={allOnGraph || !add.canAdd || add.running} onClick={() => add.add(everything)}>
              {allOnGraph ? RUN_COPY.onGraph : exactPage ? addAll(returned) : addThese(returned)}
            </button>
          )}
          <button type="button" className="secondary" onClick={onEdit}>
            {RUN_COPY.editPattern}
          </button>
          {returned === 0 ? (
            <button type="button" className="secondary" onClick={onRunAnother}>
              {runFromAnother(typeName)}
            </button>
          ) : null}
          {saveLink}
        </div>
        {returned === 0 ? null : (
          <>
            <h3 className="run-matches-heading" tabIndex={-1} ref={heading}>
              {showingHeading(before + 1, before + returned, summary.of)}
            </h3>
            <ol className="run-cards" aria-label={RUN_COPY.matches}>
              {answer.matches.map((match, index) => (
                <MatchCard key={`${match.match.entityType}/${match.match.stableId}`} number={before + index + 1} match={match} answer={answer} mask={mask} personal={personal} keyProperties={keyProperties} add={add} evidenceOpener={evidenceOpener} />
              ))}
            </ol>
            {answer.notices.map((notice, index) => (
              <p className="search-panel-note" key={`${notice.code}-${index}`}>
                {noticeText(notice)}
              </p>
            ))}
          </>
        )}
      </div>
      {page === 0 && !hasNext ? null : (
        <div className="run-footer">
          <button type="button" className="secondary" disabled={page === 0} aria-disabled={reading ? true : undefined} onClick={() => !reading && onPrevious()}>
            <span aria-hidden="true">‹ </span>
            {RUN_COPY.previous}
          </button>
          {reading ? (
            <span className="run-note" role="status">
              {RUN_COPY.readingPage}
            </span>
          ) : null}
          <button type="button" className="secondary" disabled={!hasNext} aria-disabled={reading ? true : undefined} onClick={() => !reading && onNext()}>
            {RUN_COPY.next}
            <span aria-hidden="true"> ›</span>
          </button>
        </div>
      )}
    </>
  );
}
