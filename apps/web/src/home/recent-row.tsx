import { Link } from 'react-router';
import type { InvestigationListItem, SourceProfile, SourceSummary } from '@neburyx/contracts';
import { legendGlyph } from '../workspace/legend-panel.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { CASE_REFERENCE_LABEL, CREATED, savedBadge, SOURCE_NO_LONGER_AVAILABLE, sourceStateNote, UNSAVED } from './copy.js';
import { relativeTime, utcClock, utcMoment } from './relative-time.js';

function sourceNote(item: InvestigationListItem, source: SourceSummary | undefined): string | undefined {
  if (item.sourceState !== 'available') return SOURCE_NO_LONGER_AVAILABLE;
  if (source === undefined || source.state === 'connected') return undefined;
  return sourceStateNote(source.state, source.stateReason);
}

function Entity({ item, profile }: { readonly item: InvestigationListItem; readonly profile: SourceProfile | undefined }) {
  const start = item.startingEntity;
  if (start === null) return null;
  const type = profile?.entityTypes.find((candidate) => candidate.type === start.entityType);
  return (
    <span className="recent-entity">
      <img src={legendGlyph(type?.icon ?? 'generic')} alt="" className="recent-glyph" />
      <span>{start.stableId}</span>
      <span className="recent-type">{type?.displayName ?? start.entityType}</span>
    </span>
  );
}

export function RecentRow({ item, now, source, profile }: { readonly item: InvestigationListItem; readonly now: number; readonly source: SourceSummary | undefined; readonly profile: SourceProfile | undefined }) {
  const note = sourceNote(item, source);
  return (
    <li className="recent-row">
      <div className="recent-main">
        <Link to={`${EXPLORE_PATH}/${item.id}`}>{item.title}</Link>
        <span className="badge">{item.save.state === 'saved' ? savedBadge(utcClock(item.save.savedAt)) : UNSAVED}</span>
      </div>
      <Entity item={item} profile={profile} />
      {item.caseRef === null ? null : (
        <span className="recent-case">
          <span className="recent-label">{profile?.vocabulary.caseRef ?? CASE_REFERENCE_LABEL}</span> {item.caseRef}
        </span>
      )}
      <span className="recent-source">{item.sourceAlias}</span>
      <span className="recent-time">
        {CREATED}{' '}
        <time dateTime={item.createdAt} title={utcMoment(item.createdAt)}>
          {relativeTime(item.createdAt, now)}
        </time>
      </span>
      {note === undefined ? null : <span className="recent-note">{note}</span>}
    </li>
  );
}
