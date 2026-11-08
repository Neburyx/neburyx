import type { Count, DegreePreview, ElementRef, SourceProfile } from '@neburyx/contracts';
import { useEffect, useRef, useState } from 'react';
import { cursorWasRefused, type TypeProgress } from '../api/expand-store.js';
import { useProfile } from '../canvas/profile-context.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { elementKey, nodeRefOfKey } from '../state/keys.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { degreeCountText } from './degree-text.js';
import { COUNTS_ARE_OF_RELATIONSHIPS, CLEAR, DUPLICATE_IDS, EXPAND_HEADING, INVERT_SELECTION, LOADING_NEIGHBORS, NO_LONGER_IN_SOURCE, NO_RELATIONSHIPS, NO_RELATIONSHIPS_FOUND, NO_STABLE_ID, RETRY, SELECT_ALL, SEPARATE_READS, START_OVER, PAGED_NOTE, expandLabel, loadMoreLabel, pageNote } from './expand-copy.js';
import { loadedCountText, loadedOf } from './node-counts.js';
import { neighborTypesOf, relTypesToSend, startUntickedTypes, useExpandStore } from './expand-context.js';
import { FILTERS_LEAVE_NOTHING } from './expand-copy.js';
import type { SubmenuProps } from './menu-registry.js';
import { usePreviewStore } from './preview-context.js';

/** Every mapped relationship type was counted exactly and none has a relationship: the node has no neighbor, which is not the same as a count that was not read. */
const isEmptyNode = (preview: DegreePreview): boolean => preview.byType.length > 0 && preview.byType.every((entry) => entry.count.quality === 'exact' && entry.count.value === 0);

const displayNameOf = (profile: SourceProfile | undefined, entityType: string): string => profile?.entityTypes.find((entry) => entry.type === entityType)?.displayName ?? entityType;

/** The neighbor types the checklist offers: those of the preview, in its order, then any the mapping gives that the preview did not name; with no preview, those of the mapping. */
function typesOf(preview: DegreePreview | undefined, profile: SourceProfile | undefined, entityType: string): readonly string[] {
  const mapped = neighborTypesOf(profile, entityType);
  const named = preview?.byNeighborType.map((entry) => entry.entityType) ?? [];
  return [...new Set([...named, ...mapped])];
}

interface RowProps {
  readonly name: string;
  readonly count: string | undefined;
  /** The count is a bound or unknown: the row says more can be loaded page by page. */
  readonly paged: boolean;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly progress: TypeProgress | undefined;
  /** What is loaded of this type: one number for the checklist, the card and the aggregate nodes. */
  readonly loaded: Count | undefined;
  readonly pageSize: number | undefined;
  readonly busy: boolean;
  readonly onMore: () => void;
  readonly onStartOver: () => void;
}

function TypeRow({ name, count, paged, checked, onToggle, progress, loaded, pageSize, busy, onMore, onStartOver }: RowProps) {
  return (
    <li className="neighbor-types-item">
      <button type="button" role="checkbox" aria-checked={checked} className="neighbor-types-row" onClick={onToggle}>
        <span className="neighbor-types-check" aria-hidden="true" />
        <span className="menu-label">{name}</span>
        {count === undefined ? null : <span className="neighbor-types-count">{count}</span>}
      </button>
      {paged ? <p className="neighbor-types-note neighbor-types-paged">{PAGED_NOTE}</p> : null}
      {loaded === undefined || loaded.value === 0 ? null : (
        <div className="neighbor-types-progress">
          <span className="neighbor-types-note">{loadedCountText(loaded)}</span>
          {progress === undefined ? null : progress.restartNeeded ? (
            <button type="button" className="neighbor-types-link" disabled={busy} onClick={onStartOver}>
              {START_OVER}
            </button>
          ) : progress.hasMore ? (
            <button type="button" className="neighbor-types-link" disabled={busy} onClick={onMore}>
              {loadMoreLabel(pageSize)}
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function ChecklistFor({ node, close }: { readonly node: ElementRef; readonly close: () => void }) {
  const previews = usePreviewStore();
  const expansions = useExpandStore();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const loaded = loadedOf(graph, node);
  const request = previews.forNode(node, useSessionMask());
  const state = useStoreSelector(request, (current) => current);
  const expansion = useStoreSelector(expansions.view, () => expansions.of(node));
  const client = useClientState();
  const [unticked, setCleared] = useState<ReadonlySet<string> | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const preview = state.phase === 'ready' ? state.data : undefined;
  const types = typesOf(preview, profile, node.entityType);
  const cleared: ReadonlySet<string> = unticked ?? new Set(startUntickedTypes(profile, client.presentation.view.getState().typeFilter, node.entityType, types));
  const ticked = types.filter((type) => !cleared.has(type));
  const busy = expansion.status === 'loading';
  // a refused cursor can never succeed again, so Retry is not offered for it: the type starts over instead
  const cursorRefused = cursorWasRefused(expansion);
  const capped = preview?.warnings.find((warning) => warning.code === 'counts-capped');
  const anyLoaded = [...expansion.types.values()].some((progress) => progress.loaded > 0);
  const pageSize = expansion.chosenPageSize ?? expansion.pageSize ?? preview?.pageSize;
  const listed = types.length;
  useEffect(() => {
    const here = (): boolean => body.current?.closest('.menu-panel')?.contains(document.activeElement) === true;
    // an answer that arrives after the submenu took the focus: Retry takes it when a failure appears, and the first row when the list appears
    if (state.phase === 'failed' && here()) retry.current?.focus();
    const holder = document.activeElement;
    if (listed > 0 && holder !== null && (holder === body.current || holder === body.current?.closest('.menu-panel'))) body.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus({ focusVisible: holder.matches(':focus-visible') });
  }, [state.phase, listed]);
  if (state.phase === 'ready' && types.length === 0) return <p className="neighbor-types-note">{NO_RELATIONSHIPS}</p>;
  return (
    <div className="neighbor-types-body" ref={body} tabIndex={-1}>
      {state.phase === 'failed' && state.failure.code === 'NOT_FOUND' ? (
        // a node that is gone stays gone, so there is nothing to retry
        <p className="neighbor-types-note" role="alert">
          {NO_LONGER_IN_SOURCE}
        </p>
      ) : state.phase === 'failed' ? (
        <>
          <FailureNotice failure={state.failure} />
          {canRetry(state.failure) ? (
            <button type="button" className="menu-row" ref={retry} onClick={request.reload}>
              <span className="menu-label">{RETRY}</span>
            </button>
          ) : null}
        </>
      ) : state.phase !== 'ready' ? (
        <p className="neighbor-types-note" role="status">
          {LOADING_NEIGHBORS}
        </p>
      ) : preview !== undefined && isEmptyNode(preview) ? (
        <p className="neighbor-types-note">{NO_RELATIONSHIPS_FOUND}</p>
      ) : null}
      <ul className="neighbor-types-list" aria-label="Neighbor types">
        {types.map((type) => {
          const entry = preview?.byNeighborType.find((candidate) => candidate.entityType === type);
          return (
            <TypeRow
              key={type}
              name={displayNameOf(profile, type)}
              count={entry === undefined ? undefined : degreeCountText(entry.count)}
              paged={entry !== undefined && entry.count.quality !== 'exact'}
              checked={!cleared.has(type)}
              onToggle={() => setCleared(cleared.has(type) ? new Set([...cleared].filter((other) => other !== type)) : new Set(cleared).add(type))}
              progress={expansion.types.get(type)}
              loaded={loaded.byType.get(type)}
              pageSize={pageSize}
              busy={busy}
              onMore={() => void expansions.loadMore(node, type)}
              onStartOver={() => void expansions.startOver(node, type)}
            />
          );
        })}
      </ul>
      {listed === 0 ? null : (
        <>
          <div className="neighbor-types-actions">
            <button type="button" className="neighbor-types-link" onClick={() => setCleared(new Set(types.filter((type) => !cleared.has(type))))}>
              {INVERT_SELECTION}
            </button>
            <button type="button" className="neighbor-types-link" onClick={() => setCleared(new Set())}>
              {SELECT_ALL}
            </button>
            <button type="button" className="neighbor-types-link" onClick={() => setCleared(new Set(types))}>
              {CLEAR}
            </button>
          </div>
          <button
            type="button"
            className="primary neighbor-types-expand"
            disabled={ticked.length === 0 || busy}
            onClick={() => {
              const relTypes = relTypesToSend(profile, client.presentation.view.getState().typeFilter, node.entityType, ticked);
              if (relTypes !== undefined && relTypes.length === 0) {
                // an empty list would ask over every relationship type, the off ones too, so the panel opens instead
                client.presentation.setSupernodePanel({ key: elementKey(node) });
                expansions.report(FILTERS_LEAVE_NOTHING);
              } else void expansions.expand(node, ticked, relTypes);
              close();
            }}
          >
            {expandLabel(ticked.length)}
          </button>
        </>
      )}
      {expansion.status === 'loading' ? (
        <p className="neighbor-types-note" role="status">
          {LOADING_NEIGHBORS}
        </p>
      ) : null}
      {expansion.status === 'failed' && expansion.failure !== undefined ? (
        <>
          <FailureNotice failure={expansion.failure} />
          {cursorRefused || !canRetry(expansion.failure) ? null : (
            <button type="button" className="menu-row" onClick={() => void expansions.retry(node)}>
              <span className="menu-label">{RETRY}</span>
            </button>
          )}
        </>
      ) : null}
      <div className="neighbor-types-notes">
        <p className="neighbor-types-note">{pageNote(pageSize)}</p>
        <p className="neighbor-types-note">{COUNTS_ARE_OF_RELATIONSHIPS}</p>
        {capped === undefined ? null : <p className="neighbor-types-note">{capped.reason}.</p>}
        {anyLoaded ? <p className="neighbor-types-note">{SEPARATE_READS}</p> : null}
        {expansion.duplicates ? <p className="neighbor-types-note">{DUPLICATE_IDS}</p> : null}
        {expansion.warnings.map((warning) => (
          <p key={warning} className="neighbor-types-note">
            {warning}
          </p>
        ))}
      </div>
    </div>
  );
}

/** The submenu *Expand by type*: a checklist of the neighbor types of the node the menu is about, with the counts the server gave and their quality, and the button that loads the first page of each ticked type. */
export function ExpandByTypeSubmenu({ context, close }: SubmenuProps) {
  const node = context.key === undefined ? undefined : nodeRefOfKey(context.key);
  return (
    <div className="neighbor-types" role="group" aria-label={EXPAND_HEADING}>
      <p className="neighbor-types-heading">{EXPAND_HEADING}</p>
      {node === undefined ? <p className="neighbor-types-note">{NO_STABLE_ID}</p> : <ChecklistFor node={node} close={close} />}
    </div>
  );
}
