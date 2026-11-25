import { useId, useState } from 'react';
import { ASSISTANT_COPY } from './copy.js';

function PopOutIcon() {
  return (
    <svg aria-hidden="true" className="assistant-popout-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2.5H2.5v7h7V7M7 2h3v3M10 2 5.8 6.2" />
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
        className="assistant-wide"
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
