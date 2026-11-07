import type { Facets, SearchMatchMode, SourceProfile } from '@neburyx/contracts';
import { countText, resultsText } from './count-label.js';
import { FILTERS_COPY, MATCH_MODE_LABELS, RETRY } from './copy.js';
import { isNarrowed, withEntityType, withMatchMode, type Selection } from './selection.js';

type SearchableFacets = Extract<Facets, { searchable: true }>;

export interface FiltersPanelProps {
  /** The entries to show: those of the answer, or, when the counts were not read, those of the last answer that had them (none on a first load). */
  readonly facets: SearchableFacets;
  /** False when the facet read of the answer failed: the entries are shown without their numbers. */
  readonly counted: boolean;
  readonly selection: Selection;
  readonly profile: SourceProfile;
  /** True while a new answer is on its way: the panel stays with the counts of the last one. */
  readonly loading: boolean;
  readonly onChange: (selection: Selection) => void;
  readonly onRetry: () => void;
}

const MODES: readonly SearchMatchMode[] = ['exact', 'related', 'evidence'];

/** The Filters of the Search results page: the entity types and the match modes of the match set with the size of each, a checkbox for each, the total, and Reset while something is chosen. */
export function FiltersPanel({ facets, counted, selection, profile, loading, onChange, onRetry }: FiltersPanelProps) {
  const displayName = (type: string): string => profile.entityTypes.find((entity) => entity.type === type)?.displayName ?? type;
  // a type chosen in the address that the answer has no entry for stays on the panel, checked, so it can be unchosen
  const typeNames = [...facets.entityType.map((entry) => entry.entityType), ...selection.entityTypes.filter((type) => !facets.entityType.some((entry) => entry.entityType === type))];
  const modeNames = MODES.filter((mode) => facets.matchMode.some((entry) => entry.mode === mode) || selection.matchModes.includes(mode));
  // with no entry of any answer and the counts not read, the panel has nothing to offer: it does not draw the names of the address as if they had been counted
  const unavailable = !counted && facets.entityType.length + facets.matchMode.length === 0;
  const reset = isNarrowed(selection) ? (
    <button type="button" className="link search-filters-reset" onClick={() => onChange({ entityTypes: [], matchModes: [] })}>
      {FILTERS_COPY.reset}
    </button>
  ) : null;
  const total = counted ? resultsText(facets.total) : undefined;
  return (
    <aside className="search-filters" aria-label={FILTERS_COPY.title} aria-busy={loading}>
      <p className="search-filters-title">{FILTERS_COPY.title}</p>
      {!counted ? <p role="status">{unavailable ? FILTERS_COPY.unavailable : FILTERS_COPY.countsNotRead}</p> : null}
      {unavailable ? (
        <button type="button" className="link search-filters-retry" onClick={onRetry}>
          {RETRY}
        </button>
      ) : null}
      {unavailable || typeNames.length === 0 ? null : (
        <fieldset className="search-filter-group">
          <legend>{FILTERS_COPY.entityType}</legend>
          {typeNames.map((type) => {
            const entry = facets.entityType.find((candidate) => candidate.entityType === type);
            const number = counted && entry !== undefined ? countText(entry.count) : undefined;
            return (
              <label key={type} className="search-filter">
                <input type="checkbox" checked={selection.entityTypes.includes(type)} onChange={(event) => onChange(withEntityType(selection, profile, type, event.target.checked))} />
                <span>{displayName(type)}</span>
                {number === undefined ? null : <span className="search-filter-count">{number}</span>}
              </label>
            );
          })}
        </fieldset>
      )}
      {unavailable || modeNames.length === 0 ? null : (
        <fieldset className="search-filter-group">
          <legend>{FILTERS_COPY.matchMode}</legend>
          {modeNames.map((mode) => {
            const entry = facets.matchMode.find((candidate) => candidate.mode === mode);
            const number = counted && entry !== undefined ? countText(entry.count) : undefined;
            return (
              <label key={mode} className="search-filter">
                <input type="checkbox" checked={selection.matchModes.includes(mode)} onChange={(event) => onChange(withMatchMode(selection, mode, event.target.checked))} />
                <span>{MATCH_MODE_LABELS[mode]}</span>
                {number === undefined ? null : <span className="search-filter-count">{number}</span>}
              </label>
            );
          })}
        </fieldset>
      )}
      {total === undefined ? null : <p className="search-filters-total">{total}</p>}
      {reset}
    </aside>
  );
}
