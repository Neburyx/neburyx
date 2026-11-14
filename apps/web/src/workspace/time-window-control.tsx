import { useId, useState } from 'react';
import { useProfile } from '../canvas/profile-context.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useUtcDay } from '../state/utc-day.js';
import { timeFilteredOf } from '../state/time-window.js';
import { FILTERS_PANEL_COPY, timeWindowUndatedText } from './filters-copy.js';
import { WindowPicker } from './window-picker.js';

/** The time window of the Filters panel: it filters out loaded items only. */
export function TimeWindowControl() {
  const id = useId();
  const state = useClientState();
  const profile = useProfile();
  useUtcDay();
  const graph = useLoadedGraph();
  const time = useStoreSelector(state.presentation.view, (current) => current.typeFilter.time);
  const [epoch, setEpoch] = useState(0);
  const window = time?.window;
  const timeNames = new Set(profile?.relationshipTypes.flatMap((row) => (row.observedAt === null ? [] : [row.observedAt])));
  const dated = timeNames.size > 0;
  const reason = profile === undefined ? FILTERS_PANEL_COPY.loadingTypes : dated ? undefined : FILTERS_PANEL_COPY.noTimedRelationships;
  const undated = timeFilteredOf(graph, time).undated;
  return (
    <div className="filters-section">
      <WindowPicker key={epoch} name={timeNames.size === 1 ? [...timeNames][0] : undefined} window={window ?? 'all'} onChange={(chosen) => state.setTimeWindow(chosen === 'all' ? undefined : chosen)} allLabel={FILTERS_PANEL_COPY.anyTime} disabled={reason !== undefined} describedBy={reason === undefined ? undefined : `${id}-reason`} />
      {reason === undefined ? null : (
        <p id={`${id}-reason`} className="neighbor-types-note">
          {reason}
        </p>
      )}
      <p className="neighbor-types-note">{FILTERS_PANEL_COPY.appliesToLoaded}</p>
      {window !== undefined && undated > 0 ? <p className="neighbor-types-note">{timeWindowUndatedText(undated)}</p> : null}
      {window === undefined ? null : (
        <button
          type="button"
          className="neighbor-types-link"
          onClick={() => {
            state.setTimeWindow(undefined);
            setEpoch(epoch + 1);
          }}
        >
          {FILTERS_PANEL_COPY.resetTimeWindow}
        </button>
      )}
    </div>
  );
}
