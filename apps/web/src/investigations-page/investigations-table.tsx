import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { InvestigationListItem, SourceProfile } from '@neburyx/contracts';
import { legendGlyph } from '../workspace/legend-panel.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { CASE_REFERENCE_LABEL } from '../home/copy.js';
import { utcDateTime } from '../views/format.js';
import { COLUMN_ACTIONS, COLUMN_COUNTS, COLUMN_COUNTS_LOADED, COLUMN_EDITED, COLUMN_ENTITY, COLUMN_SOURCE, COLUMN_TITLE, COUNTS_NOT_AVAILABLE, TABLE_CAPTION } from './copy.js';
import { labelOf, type Labels } from './use-row-labels.js';
import { NO_ROW_LEFT } from './use-investigation-list.js';
import { RowMenu, type RowMenuProps } from './row-menu.js';

const STATUS_CHIPS = { closed: 'Closed', archived: 'Archived' } as const;

function Entity({ item, profile, labels }: { readonly item: InvestigationListItem; readonly profile: SourceProfile | undefined; readonly labels: Labels }) {
  const start = item.startingEntity;
  if (start === null) return null;
  const type = profile?.entityTypes.find((candidate) => candidate.type === start.entityType);
  const label = labelOf(labels, item);
  return (
    <div className="investigations-entity">
      <img src={legendGlyph(type?.icon ?? 'generic')} alt="" className="investigations-glyph" />
      <span className="investigations-entity-text">
        <span className="investigations-entity-label">{label ?? ''}</span>
        <span className="investigations-entity-type">{type?.displayName ?? start.entityType}</span>
      </span>
    </div>
  );
}

export interface InvestigationsTableProps extends Pick<RowMenuProps, 'onChanged' | 'onLeft' | 'onNotice' | 'client' | 'statusFilter'> {
  readonly items: readonly InvestigationListItem[];
  readonly profiles: ReadonlyMap<string, SourceProfile>;
  readonly labels: Labels;
  readonly busy: boolean;
  /** The row whose title link takes the focus, or `NO_ROW_LEFT` for the caption; cleared once taken. */
  readonly focusId: string | undefined;
  readonly onFocusTaken: () => void;
}

export function InvestigationsTable({ items, profiles, labels, busy, focusId, onFocusTaken, ...menu }: InvestigationsTableProps) {
  const caption = useRef<HTMLTableCaptionElement>(null);
  const table = useRef<HTMLTableElement>(null);

  useEffect(() => {
    if (focusId === undefined) return;
    if (focusId === NO_ROW_LEFT) caption.current?.focus();
    else table.current?.querySelector<HTMLElement>(`a[data-investigation-link="${CSS.escape(focusId)}"]`)?.focus();
    onFocusTaken();
  }, [focusId, onFocusTaken]);

  return (
    <div className="investigations-table-wrap">
      <table ref={table} className="investigations-table" aria-busy={busy ? true : undefined}>
        <caption ref={caption} tabIndex={-1} className="visually-hidden">
          {TABLE_CAPTION}
        </caption>
        <thead>
          <tr>
            <th scope="col">{COLUMN_TITLE}</th>
            <th scope="col">{COLUMN_ENTITY}</th>
            <th scope="col">{COLUMN_SOURCE}</th>
            <th scope="col">{COLUMN_EDITED}</th>
            <th scope="col">
              {COLUMN_COUNTS}
              <span className="visually-hidden">{COLUMN_COUNTS_LOADED}</span>
            </th>
            <th scope="col">
              <span className="visually-hidden">{COLUMN_ACTIONS}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const profile = profiles.get(item.sourceId);
            return (
              <tr key={item.id}>
                <td>
                  <div className="investigations-title">
                    <Link to={`${EXPLORE_PATH}/${item.id}`} data-investigation-link={item.id}>
                      {item.title}
                    </Link>
                    {item.status === 'open' ? null : <span className="badge">{STATUS_CHIPS[item.status]}</span>}
                  </div>
                  {item.caseRef === null ? null : (
                    <div className="investigations-case">
                      <span className="investigations-case-label">{profile?.vocabulary.caseRef ?? CASE_REFERENCE_LABEL}</span> {item.caseRef}
                    </div>
                  )}
                </td>
                <td>
                  <Entity item={item} profile={profile} labels={labels} />
                </td>
                <td>{item.sourceAlias}</td>
                <td>
                  <time dateTime={item.lastEditedAt}>{utcDateTime(item.lastEditedAt)}</time>
                </td>
                <td>
                  {item.nodeCount === null || item.edgeCount === null ? (
                    <span className="visually-hidden">{COUNTS_NOT_AVAILABLE}</span>
                  ) : (
                    <span>
                      {item.nodeCount} / {item.edgeCount}
                    </span>
                  )}
                </td>
                <td className="investigations-actions">
                  <RowMenu item={item} {...menu} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
