import type { ReactNode } from 'react';
import type { AggregateEvidenceHit, AggregateMember, Count, ElementRef, EvidenceGroup, EvidenceHit, SourceProfile, StoredEvidenceHit } from '@neburyx/contracts';
import { countText } from './count-label.js';
import { AGGREGATE_NOTE, SEARCH_COPY, evidenceNotSearchedText, evidenceRecordsText, evidenceRuleText, memberText, membersText, observedText } from './copy.js';
import { useViewEvidence, type ViewEvidence } from './evidence-action.js';
import { useFocusOnMount } from './show-more.js';

const displayNameOf = (profile: SourceProfile, entityType: string): string => profile.entityTypes.find((type) => type.type === entityType)?.displayName ?? entityType;

/** An end of an aggregate as the page names it: its type and, for a type that is not keyed, its stable ID; a keyed type's reference is a token, never shown as an ID. */
function endText(profile: SourceProfile, ref: ElementRef): string {
  const keyed = profile.entityTypes.find((type) => type.type === ref.entityType)?.keyed === true;
  return keyed ? displayNameOf(profile, ref.entityType) : `${displayNameOf(profile, ref.entityType)} ${ref.stableId}`;
}

function Rules({ hit }: { readonly hit: EvidenceHit }) {
  return hit.rules.map((rule) => (
    <span key={rule.ruleId} className="search-hit-context">
      {evidenceRuleText(rule.ruleId, rule.ruleVersion)}
    </span>
  ));
}

function StoredRow({ hit, profile, viewEvidence, focus }: { readonly hit: StoredEvidenceHit; readonly profile: SourceProfile; readonly viewEvidence: ViewEvidence | undefined; readonly focus: boolean }) {
  const { supports } = hit;
  const row = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li className="search-hit" ref={row} {...(focus ? { tabIndex: -1 } : {})}>
      <div className="search-hit-text">
        <span className="search-hit-type">{supports.type}</span>
        <strong>
          {displayNameOf(profile, supports.from)} → {displayNameOf(profile, supports.to)}
        </strong>
        <span className="search-hit-summary">{evidenceRecordsText(hit.records)}</span>
        <Rules hit={hit} />
      </div>
      {viewEvidence === undefined ? null : (
        <button type="button" className="link" aria-label={`${SEARCH_COPY.viewEvidence}: ${supports.type} ${supports.stableId}`} onClick={() => viewEvidence(supports)}>
          {SEARCH_COPY.viewEvidence}
        </button>
      )}
    </li>
  );
}

/** A member is text only: no button, no link and no ID to copy, because its element ID is not a reference. */
function MemberRow({ member, focus }: { readonly member: AggregateMember; readonly focus: boolean }) {
  const item = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li ref={item} className="search-member" {...(focus ? { tabIndex: -1 } : {})}>
      {[memberText(member.elementId), evidenceRecordsText(member.records), ...(member.observedAt === undefined ? [] : [observedText(member.observedAt)])].join(' · ')}
    </li>
  );
}

function AggregateRow({ hit, profile, focus, focusMember }: { readonly hit: AggregateEvidenceHit; readonly profile: SourceProfile; readonly focus: boolean; readonly focusMember: number | undefined }) {
  const { aggregate } = hit;
  const row = useFocusOnMount<HTMLLIElement>(focus);
  return (
    <li className="search-hit search-hit-aggregate" ref={row} {...(focus ? { tabIndex: -1 } : {})}>
      <div className="search-hit-text">
        <span className="search-hit-type">{aggregate.type}</span>
        <strong>
          {endText(profile, aggregate.from)} → {endText(profile, aggregate.to)}
        </strong>
        <span className="search-hit-summary">{membersText(hit.memberCount)}</span>
        <Rules hit={hit} />
        <span className="search-hit-context">{AGGREGATE_NOTE}</span>
        <ul className="search-members">
          {hit.members.map((member, index) => (
            <MemberRow key={member.elementId} member={member} focus={index === focusMember} />
          ))}
        </ul>
      </div>
    </li>
  );
}

const storedKey = (hit: StoredEvidenceHit): string => JSON.stringify(['stored', hit.supports.type, hit.supports.from, hit.supports.to, hit.supports.stableId]);
const aggregateKey = (hit: AggregateEvidenceHit): string => JSON.stringify(['aggregate', hit.aggregate.type, hit.aggregate.from, hit.aggregate.to]);
export const evidenceKey = (hit: EvidenceHit): string => ('supports' in hit ? storedKey(hit) : aggregateKey(hit));

/** One row of the evidence list, and where the focus goes in it when the page that added it is the last one read. */
export interface EvidenceRow {
  readonly key: string;
  readonly hit: EvidenceHit;
  readonly focus: boolean;
  /** The member that takes the focus, when the page added members to an aggregate an earlier page showed. */
  readonly focusMember: number | undefined;
}

/**
 * The rows of the evidence hits of every page read: a stored hit once, and the hits of one aggregate (the same type and ends) on several pages as one row with their members in the order read,
 * each once. A merged aggregate counts the members held, exact when the group has no next page (every page from the first was read) and a lower bound while it has one. The hit at `focusAt` is
 * the first of the last page added: its row takes the focus, or, when it joined an earlier row, its first member does.
 */
export function evidenceRowsOf(hits: readonly EvidenceHit[], hasMore: boolean, focusAt: number | undefined): EvidenceRow[] {
  const rows: { key: string; hit: EvidenceHit; focus: boolean; focusMember: number | undefined }[] = [];
  const byKey = new Map<string, number>();
  hits.forEach((hit, index) => {
    const key = evidenceKey(hit);
    const at = byKey.get(key);
    const known = at === undefined ? undefined : rows[at];
    if (known === undefined) {
      byKey.set(key, rows.length);
      rows.push({ key, hit, focus: index === focusAt, focusMember: undefined });
      return;
    }
    if (!('members' in known.hit) || !('members' in hit)) return;
    const held = new Set(known.hit.members.map((member) => member.elementId));
    const added = hit.members.filter((member) => !held.has(member.elementId));
    if (index === focusAt && added.length > 0) known.focusMember = known.hit.members.length;
    known.hit = { ...known.hit, members: [...known.hit.members, ...added] };
  });
  return rows.map((row) => {
    if (!('members' in row.hit)) return row;
    const memberCount: Count = { ...row.hit.memberCount, value: row.hit.members.length, quality: hasMore ? 'lowerBound' : 'exact' };
    return { ...row, hit: { ...row.hit, memberCount } };
  });
}

/** The evidence group: its rows (those of the first page and of the pages Show more added), its count, and what is drawn under the list. */
export function EvidenceSection({ rows, count, profile, children }: { readonly rows: readonly EvidenceRow[]; readonly count: Count; readonly profile: SourceProfile; readonly children?: ReactNode }) {
  const viewEvidence = useViewEvidence();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="search-evidence-title">
      <h2 id="search-evidence-title">
        {SEARCH_COPY.evidenceTitle} ({countText(count)})
      </h2>
      <ul className="search-hits">
        {rows.map((row) =>
          'supports' in row.hit ? (
            <StoredRow key={row.key} hit={row.hit} profile={profile} viewEvidence={viewEvidence} focus={row.focus} />
          ) : (
            <AggregateRow key={row.key} hit={row.hit} profile={profile} focus={row.focus} focusMember={row.focusMember} />
          ),
        )}
      </ul>
      {children}
    </section>
  );
}

export function EvidenceNotes({ group, profile }: { readonly group: EvidenceGroup; readonly profile: SourceProfile }) {
  if (group.disabledRelationshipTypes.length === 0) return null;
  return (
    <ul className="search-notes">
      {group.disabledRelationshipTypes.map((disabled) => (
        <li key={JSON.stringify([disabled.relationshipType, disabled.from, disabled.to, disabled.property])}>
          {evidenceNotSearchedText(`${disabled.relationshipType} (${displayNameOf(profile, disabled.from)} → ${displayNameOf(profile, disabled.to)})`, disabled.property, disabled.reason)}
        </li>
      ))}
    </ul>
  );
}
