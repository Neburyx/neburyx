import type { EvidenceGroup, EvidenceHit, SourceProfile } from '@neburyx/contracts';
import { countText } from './count-label.js';
import { SEARCH_COPY, evidenceRecordsText, evidenceRuleText } from './copy.js';
import { useViewEvidence, type ViewEvidence } from './evidence-action.js';

const displayNameOf = (profile: SourceProfile, entityType: string): string => profile.entityTypes.find((type) => type.type === entityType)?.displayName ?? entityType;

function EvidenceRow({ hit, profile, viewEvidence }: { readonly hit: EvidenceHit; readonly profile: SourceProfile; readonly viewEvidence: ViewEvidence | undefined }) {
  const { supports } = hit;
  return (
    <li className="search-hit">
      <div className="search-hit-text">
        <span className="search-hit-type">{supports.type}</span>
        <strong>
          {displayNameOf(profile, supports.from)} → {displayNameOf(profile, supports.to)}
        </strong>
        <span className="search-hit-summary">{evidenceRecordsText(hit.records.map((record) => record.sourceRecordId))}</span>
        {hit.rules.map((rule) => (
          <span key={rule.ruleId} className="search-hit-context">
            {evidenceRuleText(rule.ruleId, rule.ruleVersion)}
          </span>
        ))}
      </div>
      {viewEvidence === undefined ? null : (
        <button type="button" className="link" aria-label={`${SEARCH_COPY.viewEvidence}: ${supports.type} ${supports.stableId}`} onClick={() => viewEvidence(supports)}>
          {SEARCH_COPY.viewEvidence}
        </button>
      )}
    </li>
  );
}

export function EvidenceSection({ group, profile }: { readonly group: EvidenceGroup; readonly profile: SourceProfile }) {
  const viewEvidence = useViewEvidence();
  if (group.hits.length === 0) return null;
  return (
    <section aria-labelledby="search-evidence-title">
      <h2 id="search-evidence-title">
        {SEARCH_COPY.evidenceTitle} ({countText(group.count)})
      </h2>
      <ul className="search-hits">
        {group.hits.map((hit) => (
          <EvidenceRow key={JSON.stringify([hit.supports.type, hit.supports.from, hit.supports.to, hit.supports.stableId])} hit={hit} profile={profile} viewEvidence={viewEvidence} />
        ))}
      </ul>
    </section>
  );
}

export function EvidenceNotes({ group, profile }: { readonly group: EvidenceGroup; readonly profile: SourceProfile }) {
  if (group.disabledRelationshipTypes.length === 0) return null;
  return (
    <ul className="search-notes">
      {group.disabledRelationshipTypes.map((disabled) => (
        <li key={JSON.stringify([disabled.relationshipType, disabled.from, disabled.to])}>
          {disabled.relationshipType} ({displayNameOf(profile, disabled.from)} → {displayNameOf(profile, disabled.to)}): {disabled.reason === 'no-stable-id' ? SEARCH_COPY.evidenceNoStableId : SEARCH_COPY.evidenceDisabled}.
        </li>
      ))}
    </ul>
  );
}
