import { useState } from 'react';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useStoreSelector } from '../state/store.js';
import { useAiActions, type AiActionName } from './ai-actions.js';
import { AI_LABELS, LOCKED_REASON, lockedName, notAvailableText } from './copy.js';

function Padlock() {
  return (
    <svg aria-hidden="true" className="header-ai-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}

function Sparkle() {
  return (
    <svg aria-hidden="true" className="header-ai-icon" viewBox="0 0 12 12" fill="currentColor">
      <path d="M5 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M9.5 7.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L7.5 9.5 9 9z" />
    </svg>
  );
}

/** The Ask or Summarize control of the header: locked unless `GET /v1/me` says the edition is enterprise, and nothing while that answer is not here. Activating it never sends a request: it runs the handler a feature registered, or says it is not available yet. */
export function AiHeaderControl({ action }: { readonly action: AiActionName }) {
  const shell = useShellData();
  const handlers = useAiActions();
  const handler = useStoreSelector(handlers.view, (held) => held.get(action));
  const [note, setNote] = useState<string | undefined>(undefined);
  const me = answeredData(shell.me);
  if (me === undefined && retainedFailure(shell.me) === undefined) return null;
  const label = AI_LABELS[action];
  if (me?.edition !== 'enterprise') {
    return (
      <button type="button" className="header-ai header-ai-locked" aria-disabled="true" aria-label={lockedName(action)} title={LOCKED_REASON} onClick={(event) => event.preventDefault()}>
        <Padlock />
        {label}
      </button>
    );
  }
  const run = (): void => {
    if (handler !== undefined) {
      setNote(undefined);
      handler();
      return;
    }
    setNote(notAvailableText(action));
  };
  return (
    <span className="header-ai-wrap" onBlur={() => setNote(undefined)} onKeyDown={(event) => (event.key === 'Escape' ? setNote(undefined) : undefined)}>
      <button type="button" className="header-ai header-ai-unlocked" onClick={run}>
        <Sparkle />
        {label}
      </button>
      <span role="status" className={note === undefined ? 'visually-hidden' : 'header-ai-note'}>
        {note ?? ''}
      </span>
    </span>
  );
}
