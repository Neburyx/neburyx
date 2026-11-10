import { Link } from 'react-router';
import { useClientState } from '../state/context.js';
import type { InvestigationState } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import { saveStateText } from './save-state-text.js';
import { ARCHIVED_PILL, CHANGES_NOT_SAVED_SUFFIX, CLOSED_PILL } from '../lifecycle/copy.js';
import { unsavedChangesOf } from '../draft/draft-sync.js';
import { Slot } from './slots.js';

function pillTextOf(record: NonNullable<InvestigationState['record']>, unsavedChanges: boolean): string {
  if (!record.readOnly) return saveStateText(record.save);
  return `${record.status === 'archived' ? ARCHIVED_PILL : CLOSED_PILL}${unsavedChanges ? CHANGES_NOT_SAVED_SUFFIX : ''}`;
}

export function InvestigationIdentity() {
  const state = useClientState();
  const record = useStoreSelector(state.investigation, (held) => held.record);
  const unsavedChanges = useStoreSelector(unsavedChangesOf(state), (value) => value);
  return (
    <div className="header-identity">
      <nav aria-label="Breadcrumb">
        <Link to="/investigations">Investigations</Link>
        <span aria-hidden="true"> /</span>
      </nav>
      {record === null ? null : (
        <>
          <h1 className="header-title">{record.title}</h1>
          {record.caseRef === null ? null : <span className="header-reference">{record.caseRef}</span>}
          <span role="status" className={record.save.kind === 'saved' && !record.readOnly ? 'pill pill-success' : 'pill pill-neutral'}>
            {pillTextOf(record, unsavedChanges)}
          </span>
          <Slot name="investigation-menu" />
        </>
      )}
    </div>
  );
}
