import { useEffect } from 'react';
import type { DegreePreview, ElementRef } from '@neburyx/contracts';
import type { RequestState } from '../api/use-request.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { FailureNotice, canRetry } from '../failure-notice.js';
import { useLoadedGraph, useSessionMask } from '../state/context.js';
import { createStore, readable, useStoreSelector } from '../state/store.js';
import { RETRY } from '../workspace/expand-copy.js';
import { degreeCountText } from '../workspace/degree-text.js';
import { loadedOf, scopeLineText } from '../workspace/node-counts.js';
import { usePreviewStoreWhenProvided } from '../workspace/preview-context.js';
import { COUNTING_NEIGHBORS, NOT_COUNTED, SOURCED_NEIGHBORS } from './copy.js';
import { useInspector } from './inspector.js';
import { useOrdered } from './ordered-registry.js';

const NO_REQUEST = readable(createStore<RequestState<DegreePreview>>({ phase: 'idle' }));

export function NeighborsSection({ entity }: { readonly entity: ElementRef }) {
  const previews = usePreviewStoreWhenProvided();
  const profile = useProfileWhenProvided();
  const mask = useSessionMask();
  const graph = useLoadedGraph();
  const rows = useOrdered(useInspector().neighborRows);
  const request = previews?.forNode(entity, mask);
  const state = useStoreSelector(request ?? NO_REQUEST, (current) => current);
  useEffect(() => {
    // a read the person cancelled from the banner stays idle in the session's store; showing the entity again asks again, while a cancel with the entity shown does not
    if (request?.getState().phase === 'idle') request.reload();
  }, [request]);
  if (previews === undefined || request === undefined) return null;
  const displayName = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
  if (state.phase === 'failed') {
    return (
      <section className="inspector-section" aria-label={SOURCED_NEIGHBORS}>
        <h3 className="inspector-section-title">{SOURCED_NEIGHBORS}</h3>
        <FailureNotice failure={state.failure} />
        {canRetry(state.failure) ? (
          <button type="button" className="neighbor-types-link" onClick={request.reload}>
            {RETRY}
          </button>
        ) : null}
      </section>
    );
  }
  if (state.phase === 'idle') {
    return (
      <section className="inspector-section" aria-label={SOURCED_NEIGHBORS}>
        <h3 className="inspector-section-title">{SOURCED_NEIGHBORS}</h3>
        <p>{NOT_COUNTED}</p>
        <button type="button" className="neighbor-types-link" onClick={request.reload}>
          {RETRY}
        </button>
      </section>
    );
  }
  if (state.phase !== 'ready') {
    return (
      <section className="inspector-section" aria-label={SOURCED_NEIGHBORS}>
        <h3 className="inspector-section-title">{SOURCED_NEIGHBORS}</h3>
        <p role="status">{COUNTING_NEIGHBORS}</p>
      </section>
    );
  }
  const preview = state.data;
  if (preview.byNeighborType.length === 0) return null;
  const loaded = loadedOf(graph, entity);
  return (
    <section className="inspector-section" aria-label={SOURCED_NEIGHBORS}>
      <h3 className="inspector-section-title">
        {SOURCED_NEIGHBORS}
        <span className="inspector-section-count">{degreeCountText(preview.total)}</span>
      </h3>
      <dl className="inspector-rows">
        {preview.byNeighborType.map((entry) => (
          <div key={entry.entityType} className="inspector-row">
            <dt>{displayName(entry.entityType)}</dt>
            <dd>{degreeCountText(entry.count)}</dd>
          </div>
        ))}
      </dl>
      {rows.map(({ id, content: Row }) => (
        <Row key={id} entity={entity} />
      ))}
      <p className="inspector-scope">{scopeLineText(preview.total, loaded.total)}</p>
    </section>
  );
}
