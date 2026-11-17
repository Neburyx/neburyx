import { useEffect, useId, useState } from 'react';
import { useAiAvailabilityWhenProvided, type AiFeature } from '../shell/shell-data.js';
import { useClientStateWhenProvided } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useAiActions, type AiActionName } from './ai-actions.js';
import { AI_LABELS, UNAVAILABLE_REASON, notAvailableText } from './copy.js';

function Sparkle() {
  return (
    <svg aria-hidden="true" className="header-ai-icon" viewBox="0 0 12 12" fill="currentColor">
      <path d="M5 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M9.5 7.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L7.5 9.5 9 9z" />
    </svg>
  );
}

/** Whether the panel of the action is open; a page without client state has none. */
function usePanelOpen(action: AiActionName): boolean {
  const state = useClientStateWhenProvided();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state === undefined) return undefined;
    const read = (): void => setOpen(action === 'ask' ? state.presentation.view.getState().askOpen : state.presentation.view.getState().summaryOpen);
    read();
    return state.presentation.view.subscribe(read);
  }, [state, action]);
  return open;
}

const FEATURE_OF: Readonly<Record<AiActionName, AiFeature>> = { ask: 'ask', summarize: 'summary', notes: 'summary' };

/** The Ask or Summarize control of the header bar: the available one when the status of the AI features says the feature is, dimmed with the reason when it says no or its read failed, and nothing while that answer is not here. Activating it never sends a request: it runs the handler registered for the action. */
export function AiHeaderControl({ action }: { readonly action: AiActionName }) {
  const availability = useAiAvailabilityWhenProvided(FEATURE_OF[action]);
  const handlers = useAiActions();
  const handler = useStoreSelector(handlers.view, (held) => held.get(action));
  const [note, setNote] = useState<string | undefined>(undefined);
  const panelOpen = usePanelOpen(action);
  const reasonId = useId();
  if (availability === 'pending') return null;
  const label = AI_LABELS[action];
  if (availability === 'unavailable') {
    return (
      <span className="header-ai-wrap" onBlur={() => setNote(undefined)} onKeyDown={(event) => (event.key === 'Escape' ? setNote(undefined) : undefined)}>
        <button
          type="button"
          className="header-ai header-ai-unavailable"
          aria-disabled="true"
          aria-describedby={reasonId}
          title={UNAVAILABLE_REASON}
          onClick={(event) => {
            event.preventDefault();
            setNote(UNAVAILABLE_REASON);
          }}
        >
          <Sparkle />
          {label}
        </button>
        <span id={reasonId} className="visually-hidden">
          {UNAVAILABLE_REASON}
        </span>
        <span role="status" className={note === undefined ? 'visually-hidden' : 'header-ai-note'}>
          {note ?? ''}
        </span>
      </span>
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
      <button type="button" className={panelOpen ? 'header-ai header-ai-available header-ai-active' : 'header-ai header-ai-available'} aria-expanded={panelOpen} onClick={run}>
        <Sparkle />
        {label}
      </button>
      <span role="status" className={note === undefined ? 'visually-hidden' : 'header-ai-note'}>
        {note ?? ''}
      </span>
    </span>
  );
}
