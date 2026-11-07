import { useEffect, useRef } from 'react';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { MORE_COPY, moreFailedText, RETRY, showMoreLabel } from './copy.js';
import type { GroupPages, PagedGroup } from './use-more-pages.js';

export interface ShowMoreProps<Hit> {
  readonly group: PagedGroup;
  readonly pages: GroupPages<Hit>;
  /** False while the answer shown is not the one for what is asked now: a newer search is on its way, and the button is not offered. */
  readonly current: boolean;
  readonly onShowMore: (group: PagedGroup) => void;
  readonly onSearchAgain: () => void;
}

function Problem<Hit>({ group, pages, onShowMore, onSearchAgain }: Omit<ShowMoreProps<Hit>, 'current'>) {
  const { problem } = pages;
  if (problem === undefined) return null;
  if (problem.kind === 'invalidated') {
    return (
      <div className="search-failure" role="alert">
        <p>{MORE_COPY.invalidated}</p>
        <button type="button" className="link" onClick={onSearchAgain}>
          {MORE_COPY.searchAgain}
        </button>
      </div>
    );
  }
  const { failure } = problem;
  const notice =
    problem.kind === 'group' ? (
      <p role="alert">{moreFailedText(group, problem.failure.code, problem.failure.timeoutMs)}</p>
    ) : failure.code === 'QUERY_TIMEOUT' ? (
      <p role="alert">{moreFailedText(group, failure.code, 'details' in problem.failure ? problem.failure.details?.timeoutMs : undefined)}</p>
    ) : (
      <FailureNotice failure={problem.failure} />
    );
  return (
    <div className="search-failure">
      {notice}
      {problem.kind === 'group' || canRetry(problem.failure) ? (
        <button type="button" className="link" onClick={() => onShowMore(group)}>
          {RETRY}
        </button>
      ) : null}
    </div>
  );
}

/** Under a group that has more matches: Show more, busy while its page is read, and the failure of the last page with Retry, or with Search again when the cursor no longer fits. */
export function ShowMore<Hit>({ group, pages, current, onShowMore, onSearchAgain }: ShowMoreProps<Hit>) {
  const invalidated = pages.problem?.kind === 'invalidated';
  return (
    <>
      <Problem group={group} pages={pages} onShowMore={onShowMore} onSearchAgain={onSearchAgain} />
      {!current || invalidated || pages.nextCursor === undefined || (pages.problem !== undefined && !pages.loading) ? null : (
        <button type="button" className="link search-show-more" aria-label={showMoreLabel(group)} aria-busy={pages.loading} aria-disabled={pages.loading} onClick={() => onShowMore(group)}>
          {pages.loading ? MORE_COPY.loadingMore : MORE_COPY.showMore}
        </button>
      )}
    </>
  );
}

/** Puts the focus on the element when it is first drawn and asked to: the first hit of a page Show more added. */
export function useFocusOnMount<Element extends HTMLElement>(focus: boolean) {
  const element = useRef<Element>(null);
  const asked = useRef(focus);
  useEffect(() => {
    if (asked.current) element.current?.focus();
  }, []);
  return element;
}
