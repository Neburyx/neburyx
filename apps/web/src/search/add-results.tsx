import type { GraphNode, GroupFailure, SearchResult, SourceProfile, UnreferencedHit } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import { elementKey } from '../state/keys.js';
import { ADD_COPY, captionOf, exactIdText, groupFailureText, groupNotRead, matchedByKey, matchesLine, NO_SEARCH_PROPERTIES, notSearchedLines, NOTHING_SEARCHABLE_MASKED, RETRY, SEARCH_COPY, showingResultsFor, startsWithText } from './copy.js';
import { secondsText } from './count-label.js';
import { summaryOf } from './hit-summary.js';
import { EntityFailure, SearchFailure } from './add-failure.js';
import { ShowMore, useFocusOnMount } from './show-more.js';
import type { AddEntity } from './use-add-entity.js';
import type { Typeahead } from './use-typeahead.js';
import { UnreferencedRow } from './unreferenced-row.js';
import type { GroupPages, MorePages } from './use-more-pages.js';

type EntityTypeProfile = SourceProfile['entityTypes'][number];

interface RowProps {
  readonly node: GraphNode;
  readonly type: EntityTypeProfile | undefined;
  readonly onCanvas: boolean;
  readonly adding: boolean;
  readonly failure: ApiFailure | undefined;
  readonly onAdd: (node: GraphNode) => void;
  readonly onFind: (node: GraphNode) => void;
}

function HitRow({ node, type, onCanvas, adding, failure, focus, matchLine, onAdd, onFind }: RowProps & { readonly focus: boolean; readonly matchLine?: string | undefined }) {
  const summary = [type?.displayName ?? node.display.type, ...summaryOf(node, type)].join(' · ');
  const row = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li className="search-panel-hit" data-on-canvas={onCanvas} ref={row} {...(focus ? { tabIndex: -1 } : {})}>
      <div className="search-panel-hit-line">
        <div className="search-panel-hit-text">
          <span className="search-panel-row-title">{node.display.title}</span>
          <span className="search-panel-row-type">{summary}</span>
          {matchLine === undefined ? null : <span className="search-panel-row-type">{matchLine}</span>}
        </div>
        {onCanvas ? (
          <button type="button" className="search-panel-pill" aria-label={`${ADD_COPY.onCanvas}: ${node.display.title}`} onClick={() => onFind(node)}>
            {ADD_COPY.onCanvas}
          </button>
        ) : (
          <button type="button" className="search-panel-add" aria-label={`${ADD_COPY.add} ${node.display.title}`} aria-disabled={adding} onClick={() => onAdd(node)}>
            <span className="icon icon-plus" aria-hidden="true" />
            {adding ? ADD_COPY.adding : ADD_COPY.add}
          </button>
        )}
      </div>
      {failure === undefined ? null : <EntityFailure failure={failure} />}
    </li>
  );
}

export interface Environment {
  readonly sourceId: string;
  readonly profile: SourceProfile | undefined;
  readonly loaded: ReadonlySet<string>;
  readonly adding: AddEntity;
  readonly mask: boolean;
  readonly onFind: (node: GraphNode) => void;
}

/** The hits of a group: those of the first page, then those Show more added; and its hits with no usable stable ID, which are listed and cannot be added. */
function Group({ label, nodes, matchLines, unreferenced, focusAt, unreferencedFocusAt, env }: { readonly label: string; readonly nodes: readonly GraphNode[]; readonly matchLines?: ReadonlyMap<string, string>; readonly unreferenced: readonly UnreferencedHit[]; readonly focusAt: number | undefined; readonly unreferencedFocusAt: number | undefined; readonly env: Environment }) {
  if (nodes.length + unreferenced.length === 0) return null;
  const typeOf = (entityType: string) => env.profile?.entityTypes.find((candidate) => candidate.type === entityType);
  return (
    <ul className="search-panel-rows" aria-label={label}>
      {nodes.map((node, index) => {
        const key = elementKey(node.ref);
        return <HitRow key={key} node={node} type={typeOf(node.ref.entityType)} onCanvas={env.loaded.has(key)} adding={env.adding.loading.has(key)} failure={env.adding.failures.get(key)} focus={index === focusAt} matchLine={matchLines?.get(key)} onAdd={env.adding.add} onFind={env.onFind} />;
      })}
      {unreferenced.map((hit, index) => (
        // an unreferenced hit has no key of its own; its place in the list is stable, since pages are only appended
        <UnreferencedRow key={`unreferenced:${index}`} hit={hit} typeName={typeOf(hit.entityType)?.displayName ?? hit.entityType} className="search-panel-hit" focus={index === unreferencedFocusAt} />
      ))}
    </ul>
  );
}

/** Each node once, the first kept, and none of those `without` holds: a later page can bring back a node an earlier one already shows, and the startsWith group leaves out a node the exact group shows. */
function uniqueNodes(nodes: readonly GraphNode[], without: ReadonlySet<string> = new Set()): GraphNode[] {
  const seen = new Set(without);
  return nodes.filter((node) => {
    const key = elementKey(node.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function GroupFailureLine({ failure, onRetry }: { readonly failure: GroupFailure; readonly onRetry: (() => void) | undefined }) {
  return (
    <div className="search-failure" role="alert">
      <p>{groupFailureText(failure.group, failure.code, failure.timeoutMs)}</p>
      {onRetry === undefined ? null : (
        <button type="button" onClick={onRetry}>
          {RETRY}
        </button>
      )}
    </div>
  );
}

/** `onRetry` is absent for an answer that is not the one for the text typed now: a newer search is already on its way. `pages` holds the pages Show more added to its groups. */
function Answer({ result, text, env, pages, onRetry, onSearchAgain }: { readonly result: SearchResult; readonly text: string; readonly env: Environment; readonly pages: MorePages; readonly onRetry: (() => void) | undefined; readonly onSearchAgain: () => void }) {
  const startsWith = result.startsWith;
  const exactNodes = uniqueNodes([...result.exact, ...pages.exact.more]);
  const prefixNodes = uniqueNodes(startsWith?.nodes ?? [], new Set(exactNodes.map((node) => elementKey(node.ref))));
  const matched = matchedByKey([...result.exactMatches, ...pages.exact.matches]);
  const matchLines = new Map(exactNodes.flatMap((node): [string, string][] => {
    const line = matchesLine(text, matched.get(elementKey(node.ref)));
    return line === undefined ? [] : [[elementKey(node.ref), line]];
  }));
  const exactUnreferenced = [...(result.exactUnreferenced ?? []), ...pages.exact.unreferenced];
  const prefixUnreferenced = startsWith?.unreferenced ?? [];
  const more = { current: pages.current, onShowMore: pages.showMore, onSearchAgain };
  const shownGroup = (group: GroupPages<GraphNode>) => ({ focusAt: group.focusAt, unreferencedFocusAt: group.unreferencedFocusAt });
  const typeOf = (entityType: string) => env.profile?.entityTypes.find((candidate) => candidate.type === entityType)?.displayName ?? entityType;
  const failureOf = (group: GroupFailure['group']) => result.failures.find((failure) => failure.group === group);
  const exactFailure = failureOf('exact');
  const prefixFailure = failureOf('startsWith');
  const counts = [exactFailure === undefined ? exactIdText(pages.exact.count) : groupNotRead('exact'), startsWith === undefined ? undefined : prefixFailure === undefined ? startsWithText(startsWith.count) : groupNotRead('startsWith')].filter((text): text is string => text !== undefined);
  const warnings = [...result.warnings.map((text) => ({ group: 'exact', text })), ...(startsWith?.warnings ?? []).map((text) => ({ group: 'startsWith', text }))];
  const found = exactNodes.length + prefixNodes.length + exactUnreferenced.length + prefixUnreferenced.length;
  const allDisabled = !result.searchable && result.disabledTypes.length > 0;
  return (
    <>
      {result.searchable ? <p className="search-panel-summary">{counts.join(' · ')} · <span className="search-panel-summary-time">{secondsText(result.elapsedMs)}</span></p> : null}
      {result.disabledTypes.length === 0 ? null : (
        <ul className="search-panel-notes">
          {notSearchedLines(result.disabledTypes, typeOf, 'exact').map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
          {allDisabled ? <li>{ADD_COPY.noIndexAvailable}</li> : null}
        </ul>
      )}
      {warnings.length === 0 ? null : (
        <ul className="search-panel-notes">
          {warnings.map((warning, index) => (
            <li key={`${warning.group}:${index}`}>{warning.text}</li>
          ))}
        </ul>
      )}
      {!result.searchable && result.disabledTypes.length === 0 ? <p className="search-panel-note">{env.mask ? NOTHING_SEARCHABLE_MASKED : NO_SEARCH_PROPERTIES}</p> : null}
      {result.searchable && found === 0 && result.failures.length === 0 ? <p className="search-panel-note">{SEARCH_COPY.emptyTitle}</p> : null}
      {exactFailure === undefined ? (
        <>
          <Group label={ADD_COPY.exactGroup} nodes={exactNodes} matchLines={matchLines} unreferenced={exactUnreferenced} {...shownGroup(pages.exact)} env={env} />
          <ShowMore group="exact" pages={pages.exact} {...more} />
        </>
      ) : (
        <GroupFailureLine failure={exactFailure} onRetry={onRetry} />
      )}
      {prefixFailure === undefined ? (
        // the startsWith group is a capped read with no next page
        <Group label={ADD_COPY.startsWithGroup} nodes={prefixNodes} unreferenced={prefixUnreferenced} focusAt={undefined} unreferencedFocusAt={undefined} env={env} />
      ) : (
        <GroupFailureLine failure={prefixFailure} onRetry={onRetry} />
      )}
    </>
  );
}

export interface AddResultsProps {
  readonly sourceAlias: string;
  readonly text: string;
  readonly typeahead: Typeahead;
  readonly env: Environment;
  /** The later pages of the answer shown, which Show more reads. */
  readonly pages: MorePages;
}

export function AddResults({ sourceAlias, text, typeahead, env, pages }: AddResultsProps) {
  const { answered, failure, waiting } = typeahead;
  return (
    <>
      <p className="search-panel-note">{captionOf(sourceAlias)}</p>
      {waiting ? <p role="status" className="search-panel-note">{ADD_COPY.searching}</p> : null}
      {failure === undefined ? null : <SearchFailure failure={failure} sourceId={env.sourceId} onRetry={typeahead.retry} />}
      {answered === undefined ? null : (
        <>
          {answered.text === text ? null : <p className="search-panel-note">{showingResultsFor(answered.text)}</p>}
          <Answer result={answered.result} text={answered.text} env={env} pages={pages} onRetry={answered.text === text ? typeahead.retry : undefined} onSearchAgain={typeahead.retry} />
        </>
      )}
      <p className="search-panel-note">{ADD_COPY.footnote}</p>
    </>
  );
}
