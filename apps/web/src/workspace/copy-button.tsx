import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from './clipboard.js';
import { COPIED, COULD_NOT_COPY } from './copy-button-copy.js';


type Outcome = 'copied' | 'failed' | undefined;

/** How long the Copied or Could not copy answer stays before the button is as it was. */
export const COPY_ANSWER_MS = 2000;

export interface CopyButtonProps {
  /** The accessible name and the tooltip, for example `Copy status`. */
  readonly label: string;
  /** What is put on the clipboard, exactly. */
  readonly text: string;
  /** A visible word beside the icon; without it the button is the icon alone. */
  readonly caption?: ReactNode;
  /** Which edge of the button the tooltip lines up with; `start` for a button near the left edge of its panel. */
  readonly align?: 'start' | 'end';
}

/** An icon button that copies a text. Esc hides its tooltip and stops there; with no tooltip shown, Esc goes on to the panel. */
export function CopyButton({ label, text, caption, align = 'end' }: CopyButtonProps) {
  const [outcome, setOutcome] = useState<Outcome>(undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = (hovered || focused) && !dismissed;
  useEffect(
    () => () => {
      latest.current += 1;
      clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!shown) return undefined;
    const hide = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    };
    document.addEventListener('keydown', hide, true);
    return () => document.removeEventListener('keydown', hide, true);
  }, [shown]);
  const run = async (): Promise<void> => {
    const request = (latest.current += 1);
    clearTimeout(timer.current);
    setOutcome(undefined);
    let result: Outcome = 'copied';
    try {
      await copyText(text);
    } catch {
      result = 'failed';
    }
    if (request !== latest.current) return;
    setOutcome(result);
    setDismissed(false);
    timer.current = setTimeout(() => setOutcome(undefined), COPY_ANSWER_MS);
  };
  const tip = outcome === 'copied' ? COPIED : outcome === 'failed' ? COULD_NOT_COPY : label;
  return (
    <span className="copy-button-wrap">
      <button
        type="button"
        className="copy-button"
        aria-label={label}
        onClick={() => void run()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
      >
        <span className={outcome === 'copied' ? 'icon icon-check' : 'icon icon-copy'} aria-hidden="true" />
        {caption}
      </button>
      <span className="copy-tip" data-align={align} data-shown={shown ? '' : undefined} aria-hidden="true">
        {tip}
      </span>
      <span className="copy-answer" role="status">
        {outcome === 'copied' ? COPIED : ''}
      </span>
      <span className="copy-answer" role="alert">
        {outcome === 'failed' ? COULD_NOT_COPY : ''}
      </span>
    </span>
  );
}
