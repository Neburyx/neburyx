import { useLayoutEffect, useRef } from 'react';
import { ASSISTANT_COPY } from './copy.js';

function Mark() {
  return (
    <svg aria-hidden="true" className="assistant-popped-icon" viewBox="0 0 10.4 10.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.7 1.7H0.7V9.7H8.7V6.7M9.7 4.7V0.7H5.7M9.7 0.7L4.7 5.7" />
    </svg>
  );
}

/** What the panel shows in place of the thread while the page of the chat is open in another window. `onFocusLost` is called when the note goes away while its button has the focus, so that the panel can give the focus a place. */
export function PoppedOutNote({ onShow, onFocusLost }: { readonly onShow: () => void; readonly onFocusLost: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(
    () => () => {
      if (button.current !== null && document.activeElement === button.current) onFocusLost();
    },
    [onFocusLost],
  );
  return (
    <section className="assistant-popped" aria-labelledby="assistant-popped-title">
      <p id="assistant-popped-title" className="assistant-popped-title">
        <Mark />
        {ASSISTANT_COPY.poppedOutTitle}
      </p>
      <p className="assistant-popped-body">{ASSISTANT_COPY.poppedOutBody}</p>
      <button ref={button} type="button" className="assistant-popped-button" onClick={onShow}>
        {ASSISTANT_COPY.showHere}
      </button>
    </section>
  );
}
