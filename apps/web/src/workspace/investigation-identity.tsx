import { Link } from 'react-router';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { saveStateText } from './save-state-text.js';
import { Slot } from './slots.js';

export function InvestigationIdentity() {
  const record = useStoreSelector(useClientState().investigation, (state) => state.record);
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
          <span role="status" className={record.save.kind === 'saved' ? 'pill pill-success' : 'pill pill-neutral'}>
            {saveStateText(record.save)}
          </span>
          <Slot name="investigation-menu" />
        </>
      )}
    </div>
  );
}
