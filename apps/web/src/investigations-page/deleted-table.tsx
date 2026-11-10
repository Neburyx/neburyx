import { useEffect, useRef } from 'react';
import type { InvestigationListItem, SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { CASE_REFERENCE_LABEL } from '../home/copy.js';
import { utcDateTime } from '../views/format.js';
import { COLUMN_ACTIONS, COLUMN_DELETED, COLUMN_ENTITY, COLUMN_PURGES, COLUMN_SOURCE, COLUMN_TITLE, DELETED_TABLE_CAPTION, RESTORE, restoreLabel } from './copy.js';
import { NO_ROW_LEFT } from './use-investigation-list.js';

export interface DeletedTableProps {
  readonly items: readonly InvestigationListItem[];
  readonly profiles: ReadonlyMap<string, SourceProfile>;
  readonly busy: boolean;
  /** The row whose Restore button takes the focus, or `NO_ROW_LEFT` for the caption; cleared once taken. */
  readonly focusId: string | undefined;
  readonly onFocusTaken: () => void;
  readonly client: ApiClient;
  /** The investigation is back: it leaves this list. */
  readonly onRestored: (item: InvestigationListItem) => void;
  /** It can no longer be restored (purged, or restored elsewhere): it leaves the list and the list is read again. */
  readonly onGone: (item: InvestigationListItem) => void;
  readonly onStale: () => void;
  readonly onNotice: (failure: ApiFailure | undefined) => void;
}

/** Deleted investigations: the title is plain text and there is nothing to open, since a deleted investigation is reachable by Restore only. The starting entity shows its type, never a label, because nothing is read from a source for a deleted row. */
export function DeletedTable({ items, profiles, busy, focusId, onFocusTaken, client, onRestored, onGone, onStale, onNotice }: DeletedTableProps) {
  const caption = useRef<HTMLTableCaptionElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const sending = useRef(new Set<string>());

  useEffect(() => {
    if (focusId === undefined) return;
    if (focusId === NO_ROW_LEFT) caption.current?.focus();
    else table.current?.querySelector<HTMLElement>(`button[data-restore="${CSS.escape(focusId)}"]`)?.focus();
    onFocusTaken();
  }, [focusId, onFocusTaken]);

  const restore = async (item: InvestigationListItem): Promise<void> => {
    if (sending.current.has(item.id)) return;
    sending.current.add(item.id);
    onNotice(undefined);
    const result = await client.restoreInvestigation(item.id, item.version);
    sending.current.delete(item.id);
    if (result.ok) {
      onRestored(item);
      return;
    }
    if (result.failure.code === 'NOT_FOUND') {
      onGone(item);
      return;
    }
    onNotice(result.failure);
    if (result.failure.code === 'CONFLICT') onStale();
  };

  return (
    <div className="investigations-table-wrap">
      <table ref={table} className="investigations-table" aria-busy={busy ? true : undefined}>
        <caption ref={caption} tabIndex={-1} className="visually-hidden">
          {DELETED_TABLE_CAPTION}
        </caption>
        <thead>
          <tr>
            <th scope="col">{COLUMN_TITLE}</th>
            <th scope="col">{COLUMN_ENTITY}</th>
            <th scope="col">{COLUMN_SOURCE}</th>
            <th scope="col">{COLUMN_DELETED}</th>
            <th scope="col">{COLUMN_PURGES}</th>
            <th scope="col">
              <span className="visually-hidden">{COLUMN_ACTIONS}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const profile = profiles.get(item.sourceId);
            const type = item.startingEntity === null ? undefined : profile?.entityTypes.find((candidate) => candidate.type === item.startingEntity?.entityType);
            return (
              <tr key={item.id}>
                <td>
                  <div className="investigations-title">{item.title}</div>
                  {item.caseRef === null ? null : (
                    <div className="investigations-case">
                      <span className="investigations-case-label">{profile?.vocabulary.caseRef ?? CASE_REFERENCE_LABEL}</span> {item.caseRef}
                    </div>
                  )}
                </td>
                <td>{item.startingEntity === null ? null : (type?.displayName ?? item.startingEntity.entityType)}</td>
                <td>{item.sourceAlias}</td>
                <td>{item.deletedAt === undefined ? null : <time dateTime={item.deletedAt}>{utcDateTime(item.deletedAt)}</time>}</td>
                <td>{item.purgeAfter === undefined ? null : <time dateTime={item.purgeAfter}>{utcDateTime(item.purgeAfter)}</time>}</td>
                <td className="investigations-actions">
                  <button type="button" className="secondary" data-restore={item.id} aria-label={restoreLabel(item.title)} onClick={() => void restore(item)}>
                    {RESTORE}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
