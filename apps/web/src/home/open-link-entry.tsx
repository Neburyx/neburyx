import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { OpenDeepLinkPrompt } from '../investigations/open-deep-link-prompt.js';
import { OPEN_LINK_ACTION } from './copy.js';
import { DemoCaseActions } from './demo-case-actions.js';

const PANEL_ID = 'open-link-panel';

export function OpenLinkEntry() {
  const [open, setOpen] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panel.current?.querySelector('input')?.focus();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    action.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };

  return (
    <div className="open-link">
      <div className="entry-actions">
        <button ref={action} type="button" className="link" aria-expanded={open} aria-controls={open ? PANEL_ID : undefined} onClick={() => (open ? close() : setOpen(true))}>
          {OPEN_LINK_ACTION}
        </button>
        <DemoCaseActions />
      </div>
      {open ? (
        <div id={PANEL_ID} ref={panel} onKeyDown={onKeyDown}>
          <OpenDeepLinkPrompt />
        </div>
      ) : null}
    </div>
  );
}
