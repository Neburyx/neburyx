import { useCallback, useEffect, useRef, useState } from 'react';
import type { Count, DisabledType, EvidenceHit, ExactMatch, GraphNode, GroupFailure, RelatedHit, SearchMoreRequest, SearchMoreResult, SearchPagedGroup, SearchResult, UnreferencedHit } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';

/** The groups that page with Show more: those of the Search results page, and the exact group of the canvas Search panel. */
export type PagedGroup = SearchPagedGroup;

interface HitsOf {
  readonly exact: GraphNode;
  readonly related: RelatedHit;
  readonly evidence: EvidenceHit;
}

const NO_UNREFERENCED: readonly UnreferencedHit[] = [];
const NO_MATCHES: readonly ExactMatch[] = [];
const NO_DISABLED: readonly DisabledType[] = [];

/** Why the last Show more of a group added nothing: the read of its page failed (`group`), the request failed (`request`), or the cursor no longer fits the search (`invalidated`). */
export type PageProblem = { readonly kind: 'group'; readonly failure: GroupFailure } | { readonly kind: 'request'; readonly failure: ApiFailure } | { readonly kind: 'invalidated' };

interface Stored<Hit> {
  readonly more: readonly Hit[];
  /** The matched properties of the exact group's later hits; empty for the other groups. */
  readonly matches: readonly ExactMatch[];
  readonly unreferenced: readonly UnreferencedHit[];
  readonly nextCursor: string | undefined;
  /** The group's count as the last page read gave it: the server counts the hits of every page so far, so it is shown as it is; absent until a page is read. */
  readonly count: Count | undefined;
  readonly loading: boolean;
  readonly problem: PageProblem | undefined;
  readonly focusAt: number | undefined;
  readonly unreferencedFocusAt: number | undefined;
  /** The relationship context of the related group's later pages: the failure of the last page whose context read failed, and the types left out of the reads. */
  readonly contextFailure?: GroupFailure | undefined;
  readonly contextDisabled?: readonly DisabledType[] | undefined;
}

export interface GroupPages<Hit> {
  /** The hits of the pages read after the first, in the order they came. */
  readonly more: readonly Hit[];
  /** The matched properties of the exact group's hits of those pages; empty for the other groups. */
  readonly matches: readonly ExactMatch[];
  /** The hits with no usable stable ID of the pages read after the first, in the order they came. */
  readonly unreferenced: readonly UnreferencedHit[];
  /** The cursor of the next page; absent when the group has no more. */
  readonly nextCursor: string | undefined;
  /** The group's count as the server gave it: the first page's, then the last later page's, which counts every page so far; a lower bound while there is a next page. */
  readonly count: Count;
  readonly loading: boolean;
  readonly problem: PageProblem | undefined;
  /** The position, among all the group's hits, of the first hit of the last page added: it takes the focus. */
  readonly focusAt: number | undefined;
  /** The position, among the group's unreferenced hits, of the first of the last page added, when that page added no other hit: it takes the focus then. */
  readonly unreferencedFocusAt: number | undefined;
  /** The failure of the relationship context read of a page already read, kept while the answer is shown: those pages' records have no context line. */
  readonly contextFailure: GroupFailure | undefined;
  /** The types the later pages' context reads left out for want of a stable-ID index. */
  readonly contextDisabled: readonly DisabledType[];
}

export interface SearchShown {
  /** What the shown answer is for (source, text, mask, selection) as one text: a page is kept only while what is asked now is the same. */
  readonly identity: string;
  readonly sourceId: string;
  readonly text: string;
  readonly mask: boolean;
  readonly entityTypes: readonly string[];
  readonly result: SearchResult;
}

export interface MorePages {
  readonly exact: GroupPages<GraphNode>;
  readonly related: GroupPages<RelatedHit>;
  readonly evidence: GroupPages<EvidenceHit>;
  /** True when Show more can run: the answer shown is for what is asked now. */
  readonly current: boolean;
  /** Reads the next page of a group; nothing while one of that group runs or when it has no more. */
  readonly showMore: (group: PagedGroup) => void;
}

type Groups = { readonly [Group in PagedGroup]?: Stored<HitsOf[Group]> };

interface FirstPage {
  readonly held: number;
  readonly unreferenced: number;
  readonly cursor: string | undefined;
  readonly count: Count;
}

function firstOf(result: SearchResult, group: PagedGroup): FirstPage {
  switch (group) {
    case 'exact':
      return { held: result.exact.length, unreferenced: result.exactUnreferenced?.length ?? 0, cursor: result.exactNextCursor, count: result.counts.exact };
    case 'related':
      return { held: result.related.hits.length, unreferenced: result.related.unreferenced?.length ?? 0, cursor: result.related.nextCursor, count: result.related.count };
    case 'evidence':
      return { held: result.evidence.hits.length, unreferenced: 0, cursor: result.evidence.nextCursor, count: result.evidence.count };
    default: {
      const unreachable: never = group;
      return unreachable;
    }
  }
}

function pagesOf<Hit>(result: SearchResult, group: PagedGroup, stored: Stored<Hit> | undefined): GroupPages<Hit> {
  const first = firstOf(result, group);
  return {
    more: stored?.more ?? [],
    matches: stored?.matches ?? NO_MATCHES,
    unreferenced: stored?.unreferenced ?? NO_UNREFERENCED,
    nextCursor: stored === undefined ? first.cursor : stored.nextCursor,
    count: stored?.count ?? first.count,
    loading: stored?.loading === true,
    problem: stored?.problem,
    focusAt: stored?.focusAt,
    unreferencedFocusAt: stored?.unreferencedFocusAt,
    contextFailure: stored?.contextFailure,
    contextDisabled: stored?.contextDisabled ?? NO_DISABLED,
  };
}

/** The hits a page of a group holds, in that group's shape, and its unreferenced hits. */
interface PageHits<Hit> {
  readonly hits: readonly Hit[];
  readonly matches: readonly ExactMatch[];
  readonly unreferenced: readonly UnreferencedHit[];
}

/** The stored pages of a group with the answer of its next page added: its hits appended, or the problem it had. */
/** The types left out of the context reads so far, each once. */
function mergedDisabled(before: readonly DisabledType[], added: readonly DisabledType[]): readonly DisabledType[] {
  return [...before, ...added.filter((entry) => !before.some((known) => known.entityType === entry.entityType && known.property === entry.property))];
}

function withAnswer<Hit>(held: Stored<Hit>, answer: ApiResult<SearchMoreResult>, hitsOf: (page: SearchMoreResult) => PageHits<Hit> | undefined, first: FirstPage): Stored<Hit> {
  if (!answer.ok) return { ...held, loading: false, problem: answer.failure.code === 'CURSOR_INVALIDATED' ? { kind: 'invalidated' } : { kind: 'request', failure: answer.failure } };
  const page = answer.value;
  if (page.failure !== undefined) return { ...held, loading: false, problem: { kind: 'group', failure: page.failure } };
  const added = hitsOf(page);
  if (added === undefined) return { ...held, loading: false, problem: { kind: 'request', failure: { code: 'SCHEMA_MISMATCH' } } };
  const onlyUnreferenced = added.hits.length === 0 && added.unreferenced.length > 0;
  return {
    more: [...held.more, ...added.hits],
    matches: [...held.matches, ...added.matches],
    unreferenced: [...held.unreferenced, ...added.unreferenced],
    nextCursor: page.nextCursor,
    count: page.count,
    loading: false,
    problem: undefined,
    focusAt: added.hits.length === 0 ? (onlyUnreferenced ? undefined : held.focusAt) : first.held + held.more.length,
    unreferencedFocusAt: onlyUnreferenced ? first.unreferenced + held.unreferenced.length : undefined,
    contextFailure: (page.group === 'related' ? page.contextFailure : undefined) ?? held.contextFailure,
    contextDisabled: mergedDisabled(held.contextDisabled ?? NO_DISABLED, page.group === 'related' ? (page.context?.disabledTypes ?? NO_DISABLED) : NO_DISABLED),
  };
}

const unreferencedOf = (page: SearchMoreResult): readonly UnreferencedHit[] => ('unreferenced' in page ? (page.unreferenced ?? NO_UNREFERENCED) : NO_UNREFERENCED);
const nodesOf = (page: SearchMoreResult): PageHits<GraphNode> | undefined => (page.group === 'exact' ? { hits: page.nodes, matches: page.matches, unreferenced: unreferencedOf(page) } : undefined);
const relatedOf = (page: SearchMoreResult): PageHits<RelatedHit> | undefined => (page.group === 'related' ? { hits: page.hits, matches: NO_MATCHES, unreferenced: unreferencedOf(page) } : undefined);
const evidenceOf = (page: SearchMoreResult): PageHits<EvidenceHit> | undefined => (page.group === 'evidence' ? { hits: page.hits, matches: NO_MATCHES, unreferenced: NO_UNREFERENCED } : undefined);

/** The groups with one of them changed. */
function withGroup(groups: Groups, group: PagedGroup, change: { readonly [Group in PagedGroup]: (stored: Stored<HitsOf[Group]> | undefined) => Stored<HitsOf[Group]> }): Groups {
  switch (group) {
    case 'exact':
      return { ...groups, exact: change.exact(groups.exact) };
    case 'related':
      return { ...groups, related: change.related(groups.related) };
    case 'evidence':
      return { ...groups, evidence: change.evidence(groups.evidence) };
    default: {
      const unreachable: never = group;
      return unreachable;
    }
  }
}

/**
 * The later pages of the groups of the answer shown. An answer of another search starts with none; a page that answers after the source, the text, the mask or the selection changed is
 * discarded, so a page read unmasked is never shown once masking is on; leaving aborts the reads.
 */
export function useMorePages(client: ApiClient, shown: SearchShown | undefined, asked: string): MorePages {
  const [stored, setStored] = useState<{ readonly result: SearchResult | undefined; readonly groups: Groups }>({ result: undefined, groups: {} });
  const groups: Groups = shown !== undefined && stored.result === shown.result ? stored.groups : {};
  const latest = useRef({ asked, shown, groups });
  latest.current = { asked, shown, groups };
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running) controller.abort();
    };
  }, []);

  const showMore = useCallback(
    (group: PagedGroup) => {
      const { shown: current, asked: now, groups: held } = latest.current;
      if (current === undefined || current.identity !== now) return;
      const { result } = current;
      const before = held[group];
      const cursor = before === undefined ? firstOf(result, group).cursor : before.nextCursor;
      if (before?.loading === true || cursor === undefined) return;
      const put = (change: (groups: Groups) => Groups): void => setStored((previous) => ({ result, groups: change(previous.result === result ? previous.groups : {}) }));
      const loading = <Hit>(previous: Stored<Hit> | undefined): Stored<Hit> => ({
        more: previous?.more ?? [],
        matches: previous?.matches ?? NO_MATCHES,
        unreferenced: previous?.unreferenced ?? NO_UNREFERENCED,
        nextCursor: cursor,
        count: previous?.count,
        loading: true,
        problem: undefined,
        focusAt: previous?.focusAt,
        unreferencedFocusAt: previous?.unreferencedFocusAt,
        contextFailure: previous?.contextFailure,
        contextDisabled: previous?.contextDisabled ?? NO_DISABLED,
      });
      put((groups) => withGroup(groups, group, { exact: loading, related: loading, evidence: loading }));
      const controller = new AbortController();
      controllers.current.add(controller);
      // a page of the related group asks for the relationship context of its records against the exact matches held, at most the cap of them
      const exactRefs = group === 'related' ? [...result.exact, ...(held.exact?.more ?? [])].slice(0, result.cap).map((node) => node.ref) : [];
      const request: SearchMoreRequest = { sourceId: current.sourceId, text: current.text, group, cursor, ...(current.mask ? { mask: true } : {}), ...(current.entityTypes.length === 0 ? {} : { entityTypes: [...current.entityTypes] }), ...(exactRefs.length === 0 ? {} : { exactRefs }) };
      const send = async (): Promise<ApiResult<SearchMoreResult>> => {
        try {
          return await client.searchMore(request, controller.signal);
        } catch {
          return UNEXPECTED;
        }
      };
      void send().then((answer) => {
        controllers.current.delete(controller);
        // a page of a search that is no longer the one asked is never shown, whatever it holds
        if (controller.signal.aborted || latest.current.asked !== current.identity || latest.current.shown?.result !== result) return;
        const first = firstOf(result, group);
        put((groups) =>
          withGroup(groups, group, {
            exact: (held) => withAnswer(loading(held), answer, nodesOf, first),
            related: (held) => withAnswer(loading(held), answer, relatedOf, first),
            evidence: (held) => withAnswer(loading(held), answer, evidenceOf, first),
          }),
        );
      });
    },
    [client],
  );

  const result = shown?.result;
  const current = shown !== undefined && shown.identity === asked;
  if (result === undefined) {
    const none = { more: [], matches: NO_MATCHES, unreferenced: NO_UNREFERENCED, nextCursor: undefined, count: { quality: 'unknown' as const, scope: 'search:none' }, loading: false, problem: undefined, focusAt: undefined, unreferencedFocusAt: undefined, contextFailure: undefined, contextDisabled: NO_DISABLED };
    return { exact: none, related: none, evidence: none, current, showMore };
  }
  return {
    exact: pagesOf(result, 'exact', groups.exact),
    related: pagesOf(result, 'related', groups.related),
    evidence: pagesOf(result, 'evidence', groups.evidence),
    current,
    showMore,
  };
}
