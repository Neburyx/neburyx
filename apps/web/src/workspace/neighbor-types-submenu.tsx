import type { DegreePreview, SourceProfile } from '@neburyx/contracts';
import { useEffect, useId, useRef } from 'react';
import { FailureNotice } from '../failure-notice.js';
import { useProfile } from '../canvas/profile-context.js';
import { nodeRefOfKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { degreeCountText } from './degree-text.js';
import type { SubmenuProps } from './menu-registry.js';
import { usePreviewStore } from './preview-context.js';

const COUNTS_ARE_OF_RELATIONSHIPS = 'Counts are of relationships.';

function displayNameOf(profile: SourceProfile | undefined, entityType: string): string {
  return profile?.entityTypes.find((entry) => entry.type === entityType)?.displayName ?? entityType;
}

function NeighborTypeList({ preview, profile }: { readonly preview: DegreePreview; readonly profile: SourceProfile | undefined }) {
  const notes = useId();
  if (preview.byNeighborType.length === 0) return <p className="neighbor-types-note">No relationships are mapped for this entity type.</p>;
  const capped = preview.warnings.find((warning) => warning.code === 'counts-capped');
  return (
    <>
      <ul className="neighbor-types-list" aria-label="Neighbor types">
        {preview.byNeighborType.map((entry) => (
          <li key={entry.entityType} className="neighbor-types-row" tabIndex={0} aria-describedby={notes}>
            <span className="menu-label">{displayNameOf(profile, entry.entityType)}</span>
            <span className="neighbor-types-count">{degreeCountText(entry.count)}</span>
          </li>
        ))}
      </ul>
      <div id={notes} className="neighbor-types-notes">
        <p className="neighbor-types-note">{COUNTS_ARE_OF_RELATIONSHIPS}</p>
        {capped === undefined ? null : <p className="neighbor-types-note">{capped.reason}.</p>}
      </div>
    </>
  );
}

/** The neighbor types of the node the menu is about, with the relationship counts the server gave and their quality; it asks for the preview when it is opened, and loads nothing. */
export function NeighborTypesSubmenu({ context }: SubmenuProps) {
  const previews = usePreviewStore();
  const profile = useProfile();
  const mask = useStoreSelector(context.state.mask, (current) => current);
  const ref = context.key === undefined ? undefined : nodeRefOfKey(context.key);
  const request = ref === undefined ? undefined : previews.forNode(ref, mask);
  return (
    <div className="neighbor-types" role="group" aria-label="Expand by neighbor type">
      {request === undefined ? <p className="neighbor-types-note">This item has no neighbors to show.</p> : <NeighborTypesRequest request={request} profile={profile} />}
    </div>
  );
}

function NeighborTypesRequest({ request, profile }: { readonly request: ReturnType<ReturnType<typeof usePreviewStore>['forNode']>; readonly profile: SourceProfile | undefined }) {
  const state = useStoreSelector(request, (current) => current);
  const body = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const wasFailed = useRef(false);
  useEffect(() => {
    const focusIsHere = (): boolean => body.current?.closest('.menu-panel')?.contains(document.activeElement) === true;
    // the answer arrives after the submenu took the focus, so Retry takes it when it appears, and the body keeps it when Retry is pressed and goes away
    if (state.phase === 'failed' && focusIsHere()) retry.current?.focus();
    if (state.phase === 'loading' && wasFailed.current && (document.activeElement === document.body || focusIsHere())) body.current?.focus();
    // a keyboard opening that waited for the answer holds the focus on the body or the panel, and the first row takes it when the list appears
    const holder = document.activeElement;
    if (state.phase === 'ready' && holder !== null && (holder === body.current || holder === body.current?.closest('.menu-panel'))) body.current?.querySelector<HTMLElement>('.neighbor-types-row')?.focus({ focusVisible: holder.matches(':focus-visible') });
    wasFailed.current = state.phase === 'failed';
  }, [state.phase]);
  return (
    <div className="neighbor-types-body" ref={body} tabIndex={-1}>
      {state.phase === 'ready' ? (
        <NeighborTypeList preview={state.data} profile={profile} />
      ) : state.phase === 'failed' ? (
        <>
          <FailureNotice failure={state.failure} />
          <button type="button" className="menu-row" ref={retry} onClick={request.reload}>
            <span className="menu-label">Retry</span>
          </button>
        </>
      ) : (
        <p className="neighbor-types-note" role="status">
          Loading neighbor types
        </p>
      )}
    </div>
  );
}
