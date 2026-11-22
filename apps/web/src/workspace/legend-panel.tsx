import type { IconKey, SourceProfile, StyleRuleProfile } from '@neburyx/contracts';
import { GLYPHS, glyphUri } from '../canvas/glyphs.js';
import { GLYPH_COLOR, STYLE_TONE_COLORS } from '../canvas/look.js';
import { useProfileState } from '../canvas/profile-context.js';
import { FailureNotice } from '../failure-notice.js';
import { answeredData, retainedFailure } from '../shell/shell-data.js';
import { useStoreSelector } from '../state/store.js';
import { useClientState } from '../state/context.js';
import { opensInNewTab, STYLE_RULES_GUIDE } from '../help/links.js';
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

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What a rule does, as the legend says it before the rule's label: "Amber badge", "Red color", "Icon shield" or "Larger node". */
function effectText(rule: StyleRuleProfile): string {
  const { effect } = rule;
  if ('badge' in effect) return `${capital(effect.badge)} badge`;
  if ('color' in effect) return `${capital(effect.color)} color`;
  if ('icon' in effect) return `Icon ${effect.icon}`;
  return 'Larger node';
}

const effectKind = (rule: StyleRuleProfile): string => Object.keys(rule.effect)[0] ?? '';

/** The earlier rule of the same type and effect kind that wins where both match, when there is one. */
function shadowedBy(rules: readonly StyleRuleProfile[], index: number): StyleRuleProfile | undefined {
  const rule = rules[index];
  return rule === undefined ? undefined : rules.slice(0, index).find((earlier) => earlier.appliesTo === rule.appliesTo && effectKind(earlier) === effectKind(rule));
}

/** A node as a rule marks it, as the frame draws it: an empty disc with the badge, or a larger one; the disc with the glyph in the tone for a colour, and with the rule's icon for an icon. */
function RuleSample({ rule, profile }: { readonly rule: StyleRuleProfile; readonly profile: SourceProfile }) {
  const { effect } = rule;
  const typeIcon = profile.entityTypes.find((entry) => entry.type === rule.appliesTo)?.icon ?? 'generic';
  const glyph = 'icon' in effect ? legendGlyph(effect.icon) : 'color' in effect ? glyphUri(isIconKey(typeIcon) ? typeIcon : 'generic', STYLE_TONE_COLORS[effect.color]) : legendGlyph(typeIcon);
  return (
    <span className="legend-rule-swatch" data-effect={effectKind(rule)}>
      <span className={`legend-swatch${'color' in effect ? ` legend-tone-${effect.color}` : ''}`}>
        {'badge' in effect || 'size' in effect ? null : <img src={glyph} alt="" className="legend-glyph" />}
      </span>
      {'badge' in effect ? (
        <span className={`legend-rule-badge legend-tone-${effect.badge}`} aria-hidden="true">
          !
        </span>
      ) : null}
    </span>
  );
}

/**
 * The style rules of the bound source's profile, as the entity types are read: kept on screen from the last answer while the profile is read again or when that fails; absent before the first answer, after a first read that failed and when the mapping has no rule.
 */
function StyleRules() {
  const profileState = useProfileState();
  const bound = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  const profile = bound !== null && profileState.sourceId === bound ? answeredData(profileState.request) : undefined;
  const rules = profile?.styleRules ?? [];
  if (profile === undefined || rules.length === 0) return null;
  return (
    <>
      <hr className="legend-divider" />
      <h3 className="legend-label">
        STYLE RULES <span className="legend-label-source">from neburyx.yaml</span>
      </h3>
      <ul className="legend-rules">
        {rules.map((rule, index) => {
          const winner = shadowedBy(rules, index);
          const typeName = profile.entityTypes.find((entry) => entry.type === rule.appliesTo)?.displayName ?? rule.appliesTo;
          return (
            <li key={rule.id} className={`legend-rule${'size' in rule.effect ? ' legend-rule-larger' : ''}${'color' in rule.effect ? ' legend-rule-color' : ''}`} aria-label={`${effectText(rule)}: ${rule.label}, ${rule.condition}`}>
              <RuleSample rule={rule} profile={profile} />
              <span className="legend-rule-text">
                <span className="legend-rule-title">{`${effectText(rule)}: ${rule.label}`}</span>
                <span className="legend-rule-detail">{`${rule.condition} · ${typeName}`}</span>
                {winner === undefined ? null : <span className="legend-rule-detail">{`Where both match, ${winner.label} applies.`}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="legend-note">Rules run after your access policy. A rule on a masked property never changes how an item looks.</p>
      <a className="legend-link" href={STYLE_RULES_GUIDE} {...(opensInNewTab(STYLE_RULES_GUIDE) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        Edit rules in neburyx.yaml
      </a>
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
      <StyleRules />
    </div>
  );
}
