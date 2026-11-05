import type { IconKey } from '@neburyx/contracts';
import { GLYPHS, glyphUri } from '../canvas/glyphs.js';
import { GLYPH_COLOR } from '../canvas/look.js';
import { useProfileState } from '../canvas/profile-context.js';
import { FailureNotice } from '../failure-notice.js';
import { answeredData, retainedFailure } from '../shell/shell-data.js';
import { useStoreSelector } from '../state/store.js';
import { useClientState } from '../state/context.js';
import { focusLegendToggle } from './legend-toggle.js';
import { LegendSample, type SampleKind } from './legend-samples.js';

const RELATIONSHIP_ROWS: readonly { readonly kind: SampleKind; readonly label: string }[] = [
  { kind: 'sourced', label: 'Sourced, stored in your graph' },
  { kind: 'derived', label: 'Rule-derived, not a source relationship' },
  { kind: 'aggregate', label: 'Aggregate: many source relationships as one, with a count' },
  { kind: 'direction', label: 'Arrow shows stored direction' },
];

const isIconKey = (key: string): key is IconKey => Object.hasOwn(GLYPHS, key);

/** The canvas's glyph for an icon key, and the generic one for a key the glyph set does not know. */
export function legendGlyph(key: string): string {
  return glyphUri(isIconKey(key) ? key : 'generic', GLYPH_COLOR);
}

/** What the entity types section shows: the types of the bound source's profile when it has been read, kept on screen while it is read again and when that fails, with the failure's code beside them; before the first read a loading line, after a first read that failed the code. */
function EntityTypes() {
  const profileState = useProfileState();
  const bound = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  const current = bound !== null && profileState.sourceId === bound;
  const profile = current ? answeredData(profileState.request) : undefined;
  const failure = current ? retainedFailure(profileState.request) : undefined;
  return (
    <>
      <h3 className="legend-label">ENTITY TYPES</h3>
      {failure === undefined ? null : <FailureNotice failure={failure} />}
      {profile === undefined ? (
        failure === undefined ? (
          <p role="status" className="legend-note">
            Loading entity types…
          </p>
        ) : null
      ) : profile.entityTypes.length === 0 ? (
        <p className="legend-note">No entity types in this source</p>
      ) : (
        <ul className="legend-types">
          {profile.entityTypes.map((type) => (
            <li key={type.type} className="legend-type">
              <span className="legend-swatch">
                <img src={legendGlyph(type.icon)} alt="" className="legend-glyph" />
              </span>
              <span className="legend-type-label">{type.displayName}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function LegendPanel() {
  const state = useClientState();
  return (
    <div className="legend-panel">
      <div className="legend-header">
        <h2 className="legend-heading">Legend</h2>
        <button
          type="button"
          className="legend-close"
          aria-label="Close Legend"
          onClick={() => {
            state.presentation.setLegendOpen(false);
            focusLegendToggle();
          }}
        >
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      <EntityTypes />
      <hr className="legend-divider" />
      <h3 className="legend-label">RELATIONSHIPS</h3>
      <ul className="legend-relationships">
        {RELATIONSHIP_ROWS.map((row) => (
          <li key={row.kind} className="legend-relationship">
            <LegendSample kind={row.kind} />
            <span className="legend-relationship-label">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
