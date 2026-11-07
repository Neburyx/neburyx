import { useState, type RefObject } from 'react';
import { SETUP_COPY } from './copy.js';

type CopyStatus = 'idle' | 'copied' | 'failed';

export const SETUP_NOTE_ID = 'source-setup-note';

export function SetupNote({ noteRef }: { readonly noteRef: RefObject<HTMLElement | null> }) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SETUP_COPY.command);
      setStatus('copied');
    } catch {
      // a page on a plain-http address has no clipboard, and a browser may refuse it: the person is told, and can select the command instead
      setStatus('failed');
    }
  };
  return (
    <section id={SETUP_NOTE_ID} ref={noteRef} className="setup-note" aria-label={SETUP_COPY.label} tabIndex={-1}>
      <div className="setup-command">
        <span aria-hidden="true">$</span>
        <code>{SETUP_COPY.command}</code>
        <button type="button" className="secondary" aria-label={SETUP_COPY.copy} onClick={() => void copy()}>
          <span className="icon icon-copy" aria-hidden="true" />
        </button>
      </div>
      <p>{SETUP_COPY.line}</p>
      <p role="status" className="setup-status">
        {status === 'copied' ? SETUP_COPY.copied : status === 'failed' ? SETUP_COPY.couldNotCopy : ''}
      </p>
    </section>
  );
}
