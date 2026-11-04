import { useId } from 'react';
import { COPY } from './copy.js';

export function DiagnosticsRow() {
  const noteId = useId();
  return (
    <div className="diagnostics-row">
      <button type="button" className="secondary" disabled aria-describedby={noteId}>
        {COPY.diagnosticsBundle}
      </button>
      <span id={noteId}>{COPY.comingLater}</span>
    </div>
  );
}
