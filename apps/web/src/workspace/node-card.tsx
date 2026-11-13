import { useId } from 'react';
import type { ElementRef } from '@neburyx/contracts';
import { FALLBACK_PAGE_SIZE } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { degreeCountText } from './degree-text.js';
import { COLLAPSE, COLLAPSE_LOADING, COLLAPSE_NOTHING, LEFT_OUT_NOTE, NOT_LOADED_ALL_TIME, SEPARATE_READS, START_OVER, SUPERNODE, TOTAL_NO_COUNT, loadMoreLabel, loadMoreOverAllLabel } from './expand-copy.js';
import { WINDOW_SHOW_ALL_TIME, windowAllTimeText, windowEmptyText } from './expand-copy.js';
import { showAllTime, windowStatusOf } from './window-status.js';
import { neighborTypesOf, useExpandStore } from './expand-context.js';
import { isSupernode, loadedCountText, loadedOf, notLoadedOf, notLoadedText } from './node-counts.js';
import { allNeighborTypes } from './supernode-options.js';
import { usePreviewStore } from './preview-context.js';

/** The card of a node in the panel: its total degree as the source counts it, what is loaded of it and what is not, each neighbor type with its counts, and the buttons that load the next page of a type. */
export function NodeCard({ node }: { readonly node: ElementRef }) {
  const previews = usePreviewStore();
  const expansions = useExpandStore();
  const profile = useProfileWhenProvided();
  const graph = useLoadedGraph();
  const mask = useSessionMask();
  const request = previews.forNode(node, mask);
  const state = useStoreSelector(request, (current) => current);
  const expansion = useStoreSelector(expansions.view, () => expansions.of(node));
  useStoreSelector(expansions.records, (version) => version);
  const collapsible = expansions.collapsibility(node);
  const reasonId = useId();
  const preview = state.phase === 'ready' ? state.data : undefined;
  const loaded = loadedOf(graph, node);
  const typeName = (profile?.entityTypes.find((entry) => entry.type === node.entityType)?.displayName ?? node.entityType).toUpperCase();
  const displayName = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
  const types = [...new Set([...allNeighborTypes(preview, neighborTypesOf(profile, node.entityType)), ...loaded.byType.keys()])];
  const pageSize = expansion.chosenPageSize ?? expansion.pageSize ?? preview?.pageSize ?? FALLBACK_PAGE_SIZE;
  const busy = expansion.status === 'loading';
  const remainder = notLoadedOf(preview?.total, loaded.total);
  return (
    <section className="supernode-card" aria-label="Node">
      <p className="supernode-card-kind">
        {typeName}
        {isSupernode(preview) ? ` · ${SUPERNODE}` : ''}
      </p>
      <p className="supernode-card-total">{preview === undefined ? TOTAL_NO_COUNT : `Total degree ${degreeCountText(preview.total)}`}</p>
      <p className="supernode-card-loaded">
        {loadedCountText(loaded.total)} · {preview === undefined ? 'not loaded: no count' : notLoadedText(remainder)}
      </p>
      <ul className="supernode-card-types">
        {types.map((type) => {
          const total = preview?.byNeighborType.find((entry) => entry.entityType === type)?.count;
          const have = loaded.byType.get(type);
          const left = notLoadedOf(total, have ?? { value: 0, quality: 'exact', scope: 'loaded in this view' });
          const progress = expansion.types.get(type);
          const chain = expansions.relTypesOf(node, type);
          const narrowed = chain !== undefined && chain.length > 0;
          const windowStatus = windowStatusOf(expansions.refinementOf(node, type)?.window, progress, (expansions.refinementOf(node, type)?.filters.length ?? 0) > 0);
          const windowed = windowStatus !== undefined;
          const finished = left !== undefined && left.value === 0 && left.quality === 'exact';
          const exhausted = progress !== undefined && !progress.hasMore && !progress.restartNeeded && !narrowed && !windowed && left !== undefined && left.value !== 0;
          const action = finished
            ? undefined
            : progress?.restartNeeded
              ? ('restart' as const)
              : progress?.hasMore && progress.cursor !== undefined
                ? ('more' as const)
                : progress === undefined || narrowed
                  ? ('first' as const)
                  : undefined;
          return (
            <li key={type} className="supernode-card-type">
              <span className="supernode-card-name">{displayName(type)}</span>
              <span className="neighbor-types-count">{total === undefined ? 'no count' : degreeCountText(total)}</span>
              <span className="neighbor-types-note">
                {have === undefined ? '0 loaded' : loadedCountText(have)} · {notLoadedText(left)}
                {windowed ? ` · ${NOT_LOADED_ALL_TIME}` : ''}
              </span>
              {windowStatus?.count === undefined ? null : <span className="neighbor-types-note">{windowStatus.count}</span>}
              {windowStatus?.empty === undefined ? null : (
                <>
                  <span className="neighbor-types-note">{windowEmptyText(windowStatus.empty)}</span>
                  {windowAllTimeText(total) === undefined ? null : <span className="neighbor-types-note">{windowAllTimeText(total)}</span>}
                  <button
                    type="button"
                    className="neighbor-types-link"
                    aria-disabled={busy ? true : undefined}
                    aria-label={`${WINDOW_SHOW_ALL_TIME}: ${displayName(type)}`}
                    onClick={() => {
                      if (busy) return;
                      showAllTime(expansions, node, type);
                    }}
                  >
                    {WINDOW_SHOW_ALL_TIME}
                  </button>
                </>
              )}
              {windowStatus?.notes.map((note) => (
                <span key={note} className="neighbor-types-note">
                  {note}
                </span>
              ))}
              {windowStatus?.ended === undefined ? null : <span className="neighbor-types-note">{windowStatus.ended}</span>}
              {action === undefined ? null : (
                <button
                  type="button"
                  className="neighbor-types-link"
                  aria-disabled={busy ? true : undefined}
                  aria-label={`${action === 'restart' ? START_OVER : action === 'more' ? loadMoreLabel(pageSize) : narrowed ? loadMoreOverAllLabel(pageSize) : loadMoreLabel(pageSize)}: ${displayName(type)}`}
                  onClick={() => busy ? undefined : void (action === 'restart' ? expansions.startOver(node, type) : action === 'more' ? expansions.loadMore(node, type) : expansions.expand(node, [type]))}
                >
                  {action === 'restart' ? START_OVER : action === 'more' ? loadMoreLabel(pageSize) : narrowed ? loadMoreOverAllLabel(pageSize) : loadMoreLabel(pageSize)}
                </button>
              )}
              {exhausted ? (
                <span className="neighbor-types-note">
                  {SEPARATE_READS} {LEFT_OUT_NOTE}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="supernode-card-actions">
        <button
          type="button"
          className="neighbor-types-link"
          aria-disabled={collapsible === 'yes' ? undefined : true}
          aria-describedby={collapsible === 'yes' ? undefined : reasonId}
          onClick={() => (collapsible === 'yes' ? void expansions.collapse(node) : undefined)}
        >
          {COLLAPSE}
        </button>
        {collapsible === 'yes' ? null : (
          <span id={reasonId} className="neighbor-types-note">
            {collapsible === 'loading' ? COLLAPSE_LOADING : COLLAPSE_NOTHING}
          </span>
        )}
      </p>
    </section>
  );
}
