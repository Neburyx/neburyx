import { useId, useState } from 'react';
import { ASSISTANT_COPY } from './copy.js';

function PopOutIcon() {
  return (
    <svg aria-hidden="true" className="assistant-popout-icon" viewBox="0 0 21 21" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 7H6V15H14V12M15 10V6H11M15 6L10 11" />
    </svg>
  );
}

/** The Pop out icon button of the panel header, with the name and the sentence of its tooltip shown on hover and on keyboard focus. */
export function PopOutButton({ pressed, onPress }: { readonly pressed: boolean; readonly onPress: () => void }) {
  const [shown, setShown] = useState(false);
  const tipId = useId();
  return (
    <span className="assistant-popout">
      <button
        type="button"
        className="assistant-wide assistant-popout-button"
        aria-label={ASSISTANT_COPY.popOut}
        aria-pressed={pressed}
        aria-describedby={shown ? tipId : undefined}
        onClick={onPress}
        onMouseEnter={() => setShown(true)}
        onMouseLeave={() => setShown(false)}
        onFocus={(event) => setShown(event.currentTarget.matches(':focus-visible'))}
        onBlur={() => setShown(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && shown) {
            event.stopPropagation();
            setShown(false);
          }
        }}
      >
        <PopOutIcon />
      </button>
      {shown ? (
        <span id={tipId} role="tooltip" className="assistant-popout-tip">
          <strong>{ASSISTANT_COPY.popOut}</strong>
          <span>{ASSISTANT_COPY.popOutTip}</span>
        </span>
      ) : null}
    </span>
  );
}
