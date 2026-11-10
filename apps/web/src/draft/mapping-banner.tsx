import { useEffect } from 'react';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useBanner } from '../banner/banner-context.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { droppedFilterText, joined, MAPPING_CHANGED_BANNER_ID, MAPPING_CHANGED_CHIP, MAPPING_CHANGED_HEADLINE, NEWLY_SENSITIVE, NOTHING_HAD_TO_CHANGE, UNMAPPED_ITEMS_SENTENCE } from './mapping-notice-copy.js';
import { mappingNoticesOf } from './mapping-notice.js';

/** A filter is named by the display name of its entity type while the mapping has the type, and by the name it was saved under when it does not. */
export function MappingChangeBanner() {
  const state = useClientState();
  const banner = useBanner();
  const mask = useSessionMask();
  const profile = useProfileWhenProvided();
  const notice = useStoreSelector(mappingNoticesOf(state).notice, (current) => current);
  const shownId = useStoreSelector(state.investigation, (current) => current.id);
  const status = useStoreSelector(state.investigation, (current) => current.record?.status);
  const active = notice !== undefined && notice.investigationId === shownId && notice.canChange && status === 'open' ? notice : undefined;
  const onScreen = useStoreSelector(banner.view, (current) => current.banner?.id === MAPPING_CHANGED_BANNER_ID);
  useEffect(() => {
    if (active === undefined) return undefined;
    const named = active.droppedFilters.map((filter) => droppedFilterText(filter.kind === 'entityType' ? (profile?.entityTypes.find((entry) => entry.type === filter.name)?.displayName ?? filter.name) : filter.name, filter.reason));
    const parts = [
      ...(named.length === 0 ? [] : [`Dropped filters: ${joined(named)}.`]),
      ...(mask && active.droppedFilters.some((filter) => filter.reason === 'now-personal') ? [NEWLY_SENSITIVE] : []),
      ...(active.hasUnmapped ? [UNMAPPED_ITEMS_SENTENCE] : []),
    ];
    banner.setStanding({ id: MAPPING_CHANGED_BANNER_ID, tone: 'warning', chip: MAPPING_CHANGED_CHIP, headline: MAPPING_CHANGED_HEADLINE, text: parts.length === 0 ? NOTHING_HAD_TO_CHANGE : parts.join(' '), actions: [], dismissible: true, onDismiss: () => mappingNoticesOf(state).set(undefined) });
    return () => banner.setStanding(undefined);
  }, [active, banner, mask, profile, state]);
  useEffect(() => {
    if (onScreen) active?.onShown?.();
  }, [onScreen, active]);
  return null;
}
