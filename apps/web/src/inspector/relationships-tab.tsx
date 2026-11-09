import { useEffect, useRef, useState } from 'react';
import type { Count, DegreePreview } from '@neburyx/contracts';
import type { RequestState } from '../api/use-request.js';
import { FALLBACK_PAGE_SIZE } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { FailureNotice, canRetry } from '../failure-notice.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { createStore, readable, useStoreSelector } from '../state/store.js';
import { degreeCountText } from '../workspace/degree-text.js';
import { RETRY } from '../workspace/expand-copy.js';
import { loadedByRelationshipType, loadedCountText, loadedOf, scopeLineText } from '../workspace/node-counts.js';
import { usePreviewStoreWhenProvided } from '../workspace/preview-context.js';
import { COUNTING_NEIGHBORS, FROM_THIS_ENTITY, NO_RELATIONSHIPS_DRAWN, ORIGIN_NOT_STATED_GROUP, RULE_DERIVED, RULE_DERIVED_GROUP, SHOW_MORE, TO_THIS_ENTITY, leftOutText } from './copy.js';
import type { InspectorTabProps } from './inspector-tabs.js';
import { relationshipList, type RelationshipRow } from './relationship-rows.js';

const NO_REQUEST = readable(createStore<RequestState<DegreePreview>>({ phase: 'idle' }));
/** An aggregate of exactly one member reads as the plain relationship it is. */
const isOneExact = (count: Count): boolean => count.value === 1 && count.quality === 'exact';
const NO_COUNT: Count = { value: 0, quality: 'exact', scope: 'loaded in this view' };

function Rows({ title, count, rows, pageSize, showType }: { readonly title: string; readonly count: string | undefined; readonly rows: readonly RelationshipRow[]; readonly pageSize: number; readonly showType: boolean }) {
  const state = useClientState();
  const profile = useProfileWhenProvided();
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  const [pages, setPages] = useState(1);
  const shown = pages * pageSize;
  const firstNew = useRef<number | undefined>(undefined);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const index = firstNew.current;
    if (index === undefined) return;
    firstNew.current = undefined;
    buttons.current[index]?.focus();
  }, [pages]);
  const typeName = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
  const heading = `${title}${count === undefined ? '' : ` · ${count}`}`;
  return (
    <section className="relationship-group" aria-label={title}>
      <h3 className="inspector-section-title">
        <span>{title}</span>
        {count === undefined ? null : <span className="inspector-section-count">{count}</span>}
      </h3>
      <ul className="relationship-rows" aria-label={heading}>
        {rows.slice(0, shown).map((row, index) => {
          const end = `${row.otherEnd.display.title} · ${row.edge.semantics === 'derived' ? RULE_DERIVED : typeName(row.otherEnd.ref.entityType)}${'aggregate' in row.edge.ref && row.edge.memberCount !== undefined && !isOneExact(row.edge.memberCount) ? ` · ${degreeCountText(row.edge.memberCount)}` : ''}`;
          const selected = selection.has(row.key);
          return (
            <li key={row.key}>
              <button
                ref={(element) => void (buttons.current[index] = element)}
                type="button"
                className="relationship-row"
                aria-current={selected ? 'true' : undefined}
                aria-label={`${row.edge.type}, ${end}, ${row.outgoing ? FROM_THIS_ENTITY : TO_THIS_ENTITY}`}
                onClick={() => state.presentation.select([row.key])}
              >
                {showType ? <span>{row.edge.type}</span> : null}
                <span>{end}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > shown ? (
        <button
          type="button"
          className="neighbor-types-link"
          onClick={() => {
            firstNew.current = shown;
            setPages(pages + 1);
          }}
        >
          {SHOW_MORE}
        </button>
      ) : null}
    </section>
  );
}

export function RelationshipsTab({ entity }: InspectorTabProps) {
  const previews = usePreviewStoreWhenProvided();
  const mask = useSessionMask();
  const loaded = useLoadedGraph();
  const visible = useVisibleGraph();
  const request = previews?.forNode(entity, mask);
  const state = useStoreSelector(request ?? NO_REQUEST, (current) => current);
  useEffect(() => {
    if (request?.getState().phase === 'idle') request.reload();
  }, [request]);
  const preview = state.phase === 'ready' ? state.data : undefined;
  const list = relationshipList(loaded, visible, entity, preview);
  const byType = loadedByRelationshipType(loaded, entity);
  const pageSize = preview?.pageSize ?? FALLBACK_PAGE_SIZE;
  const none = list.groups.every((group) => group.rows.length === 0) && list.derived.length === 0 && list.unknownOrigin.length === 0;
  const total = loadedOf(loaded, entity).total;
  return (
    <div className="inspector-relationships">
      {state.phase === 'failed' ? (
        <>
          <FailureNotice failure={state.failure} />
          {canRetry(state.failure) && request !== undefined ? (
            <button type="button" className="neighbor-types-link" onClick={request.reload}>
              {RETRY}
            </button>
          ) : null}
        </>
      ) : state.phase === 'loading' ? (
        <p role="status">{COUNTING_NEIGHBORS}</p>
      ) : null}
      {none ? <p>{NO_RELATIONSHIPS_DRAWN}</p> : null}
      {list.groups.map((group) => {
        const have = byType.get(group.type) ?? NO_COUNT;
        const count = group.total?.value === undefined ? loadedCountText(have) : `${loadedCountText(have)} of ${degreeCountText(group.total)}`;
        return <Rows key={group.type} title={group.type} count={count} rows={group.rows} pageSize={pageSize} showType={false} />;
      })}
      {list.derived.length === 0 ? null : <Rows title={RULE_DERIVED_GROUP} count={undefined} rows={list.derived} pageSize={pageSize} showType />}
      {list.unknownOrigin.length === 0 ? null : <Rows title={ORIGIN_NOT_STATED_GROUP} count={undefined} rows={list.unknownOrigin} pageSize={pageSize} showType />}
      {list.leftOut === 0 ? null : <p className="inspector-scope">{leftOutText(list.leftOut)}</p>}
      <p className="inspector-scope">{scopeLineText(preview?.total, total)}</p>
    </div>
  );
}
