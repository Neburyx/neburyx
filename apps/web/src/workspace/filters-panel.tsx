import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useProfile } from '../canvas/profile-context.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { filteredKeys, outsideFocusKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { FILTERS_PANEL_COPY, selectedRelationshipTypesText } from './filters-copy.js';
import { focusFiltersTool } from './filters-tool.js';
import { filterResultLine, relationshipResultLine } from './scope-text.js';

/** The Filters panel: the entity types of the mapping as chips, each on or off. */
export function FiltersPanel() {
  const state = useClientState();
  const profile = useProfile();
  const root = useRef<HTMLDivElement>(null);
  const typeFilter = useStoreSelector(state.presentation.view, (current) => current.typeFilter);
  const off = typeFilter.offEntityTypes;
  const handHidden = useStoreSelector(state.presentation.view, (current) => current.hidden);
  const neighborhoodFocus = useStoreSelector(state.presentation.view, (current) => current.neighborhoodFocus);
  const graph = useLoadedGraph();
  const filtered = filteredKeys(graph, typeFilter);
  // an entity out of the view by hand or outside the neighborhood focus is counted by those parts, not here
  const hidden = useMemo(() => new Set([...handHidden, ...outsideFocusKeys(graph, neighborhoodFocus, handHidden)]), [handHidden, neighborhoodFocus, graph]);
  const loaded = graph.nodes.map((node) => elementKey(node.ref));
  const result = filterResultLine(loaded, hidden, filtered);
  const relationshipTypes = [...new Set((profile?.relationshipTypes ?? []).map((type) => type.type))];
  const offRelationships = typeFilter.offRelationshipTypes;
  const relationshipResult = relationshipResultLine(graph, hidden, filtered, offRelationships);
  const anyOff = off.size > 0 || typeFilter.offRelationshipTypes.size > 0;
  const close = (): void => {
    state.presentation.setFiltersOpen(false);
    focusFiltersTool();
  };
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('.filter-chip')?.focus();
  }, [profile === undefined]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const types = profile?.entityTypes ?? [];
  return (
    <div className="filters-panel" ref={root} onKeyDown={onKeyDown}>
      <h2 className="search-panel-heading">{FILTERS_PANEL_COPY.title}</h2>
      <div className="filters-section" role="status">
        <p className="neighbor-types-note">{result ?? FILTERS_PANEL_COPY.nothingLoaded}</p>
        {relationshipResult === undefined ? null : <p className="neighbor-types-note">{relationshipResult}</p>}
      </div>
      <div role="group" aria-label={FILTERS_PANEL_COPY.entityTypes} className="filters-section">
        <span className="supernode-label">{FILTERS_PANEL_COPY.entityTypes}</span>
        {profile === undefined ? (
          <p className="neighbor-types-note" role="status">
            {FILTERS_PANEL_COPY.loadingTypes}
          </p>
        ) : types.length === 0 ? (
          <p className="neighbor-types-note">{FILTERS_PANEL_COPY.noEntityTypes}</p>
        ) : (
          <ul className="filter-chips">
            {types.map((type) => (
              <li key={type.type}>
                <button type="button" className="filter-chip" aria-pressed={!off.has(type.type)} onClick={() => state.setEntityTypeOff(type.type, !off.has(type.type))}>
                  {type.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
        {anyOff ? (
          <button
            type="button"
            className="neighbor-types-link"
            onClick={() => {
              state.presentation.resetTypeFilter();
              root.current?.querySelector<HTMLElement>('.filter-chip')?.focus();
            }}
          >
            {FILTERS_PANEL_COPY.reset}
          </button>
        ) : null}
      </div>
      {profile === undefined ? null : (
        <div role="group" aria-label={FILTERS_PANEL_COPY.relationshipTypes} className="filters-section">
          <span className="supernode-label">{FILTERS_PANEL_COPY.relationshipTypes}</span>
          {relationshipTypes.length === 0 ? (
            <p className="neighbor-types-note">{FILTERS_PANEL_COPY.noRelationshipTypes}</p>
          ) : (
            <>
              <p className="neighbor-types-note">{selectedRelationshipTypesText(relationshipTypes.filter((type) => !offRelationships.has(type)).length, relationshipTypes.length)}</p>
              <ul className="neighbor-types-list" aria-label={FILTERS_PANEL_COPY.relationshipTypes}>
                {relationshipTypes.map((type) => (
                  <li key={type} className="neighbor-types-item">
                    <button type="button" role="checkbox" aria-checked={!offRelationships.has(type)} className="neighbor-types-row" onClick={() => state.setRelationshipTypeOff(type, !offRelationships.has(type))}>
                      <span className="neighbor-types-check" aria-hidden="true" />
                      <span className="menu-label">{type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <button type="button" className="legend-close filters-close" aria-label={FILTERS_PANEL_COPY.close} onClick={close}>
        <span className="icon icon-clear" aria-hidden="true" />
      </button>
    </div>
  );
}
