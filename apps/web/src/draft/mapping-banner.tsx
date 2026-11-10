import { useEffect } from 'react';
import { useBanner } from '../banner/banner-context.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { filteredKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { droppedFilterText, FILTERS_STILL_HIDE, joined, MAPPING_CHANGED_BANNER_ID, MAPPING_CHANGED_CHIP, MAPPING_CHANGED_HEADLINE, NEWLY_SENSITIVE, NOTHING_HAD_TO_CHANGE, UNMAPPED_ITEMS_SENTENCE } from './mapping-notice-copy.js';
import { mappingNoticesOf } from './mapping-notice.js';

export function MappingChangeBanner() {
  const state = useClientState();
  const banner = useBanner();
  const mask = useSessionMask();
  const notice = useStoreSelector(mappingNoticesOf(state).notice, (current) => current);
  const shownId = useStoreSelector(state.investigation, (current) => current.id);
  const status = useStoreSelector(state.investigation, (current) => current.record?.status);
  const active = notice !== undefined && notice.investigationId === shownId && notice.canChange && status === 'open' ? notice : undefined;
  const graph = useLoadedGraph();
  const typeFilter = useStoreSelector(state.presentation.view, (view) => view.typeFilter);
  // the sentence is true of what the person sees only when a loaded entity or relationship is held back by a type that is off
  const typesHidden = filteredKeys(graph, typeFilter).size > 0 || graph.edges.some((edge) => typeFilter.offRelationshipTypes.has(edge.type));
  const onScreen = useStoreSelector(banner.view, (current) => current.banner?.id === MAPPING_CHANGED_BANNER_ID);
  useEffect(() => {
    if (active === undefined) return undefined;
    const named = active.droppedFilters.map((filter) => droppedFilterText(filter.name, filter.reason));
    const parts = [
      ...(named.length === 0 ? [] : [`Dropped filters: ${joined(named)}.`]),
      ...(mask && active.droppedFilters.some((filter) => filter.reason === 'now-personal') ? [NEWLY_SENSITIVE] : []),
      ...(active.hasUnmapped ? [UNMAPPED_ITEMS_SENTENCE] : []),
      ...(typesHidden ? [FILTERS_STILL_HIDE] : []),
    ];
    banner.setStanding({ id: MAPPING_CHANGED_BANNER_ID, tone: 'warning', chip: MAPPING_CHANGED_CHIP, headline: MAPPING_CHANGED_HEADLINE, text: parts.length === 0 ? NOTHING_HAD_TO_CHANGE : parts.join(' '), actions: [], dismissible: true, onDismiss: () => mappingNoticesOf(state).set(undefined) });
    return () => banner.setStanding(undefined);
  }, [active, banner, mask, typesHidden, state]);
  useEffect(() => {
    if (onScreen) active?.onShown?.();
  }, [onScreen, active]);
  return null;
}
