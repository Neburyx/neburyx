import { useEffect, useId, useRef, useState } from 'react';
import type { ApiFailure } from '../api/client.js';
import { FailureBox } from '../failure-box.js';
import { RETRY_NAMES } from '../failure-copy.js';
import { failureText } from '../failure-notice.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';

/** The rail has no room for a sentence: a button opens the failed read of the account beside it. */
function RailFailure({ failure, retry }: { readonly failure: ApiFailure; readonly retry: () => void }) {
  const [open, setOpen] = useState(false);
  const popover = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || root.current?.contains(document.activeElement) !== true) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const onPress = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [open]);
  return (
    <div className="rail-failure" ref={root}>
      <button type="button" ref={button} className="rail-failure-button" aria-label={failureText(failure)} aria-expanded={open} aria-controls={open ? popover : undefined} onClick={() => setOpen((held) => !held)}>
        <span aria-hidden="true">!</span>
      </button>
      {open ? (
        <div className="rail-failure-popover" id={popover}>
          <FailureBox failure={failure} retry={{ name: RETRY_NAMES.account, run: retry }} />
        </div>
      ) : null}
    </div>
  );
}

export function RailIdentity() {
  const { me, reloadMe } = useShellData();
  const failure = retainedFailure(me);
  if (failure !== undefined) return <RailFailure failure={failure} retry={reloadMe} />;
  return answeredData(me) === undefined ? null : <p className="rail-caption">Local workspace</p>;
}
