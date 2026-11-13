import { useId, useState } from 'react';
import { readDays, windowKey, type ExpandWindow } from '../api/expand-window.js';
import { WINDOW_ALL_TIME, WINDOW_DAYS_LABEL, WINDOW_LABEL, WINDOW_NOTE_ALL, WINDOW_NOTE_DAYS, WINDOW_NOTE_NONE, WINDOW_OTHER, WINDOW_UTC, windowDatesText, windowDaysLabel } from './expand-copy.js';

const PRESETS: readonly number[] = [7, 30, 90, 365];
const ALL = 'all';
const OTHER = 'other';

interface WindowFieldProps {
  readonly window: ExpandWindow;
  readonly onChange: (window: ExpandWindow) => void;
  /** The two UTC instants the server resolved the window to in the last answer for this node; the dates are shown from them only. */
  readonly range?: { readonly from: string; readonly to: string } | undefined;
  /** Whether the relationship types the controls now ask for have an observed time: all, some or none (from the source profile). */
  readonly dated: 'all' | 'some' | 'none';
  /** Told whenever the days typed are not a valid number, so that the controls send nothing until they are. */
  readonly onProblem?: ((problem: string | undefined) => void) | undefined;
}

/** The time window of an expansion: the last 7 days until a person chooses another number of days or all time; a number outside the presets is typed. */
export function ExpandWindowField({ window, onChange, range, dated, onProblem }: WindowFieldProps) {
  const id = useId();
  const custom = window !== 'all' && !PRESETS.includes(window.days);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const showNumber = typing || custom;
  const shown = showNumber ? OTHER : window === 'all' ? ALL : String(window.days);
  const read = readDays(showNumber ? (typing ? text : custom ? String(window.days) : '') : '7');
  const problem = typing && !read.ok ? read.reason : undefined;
  return (
    <div className="supernode-field">
      <label className="supernode-label" htmlFor={`${id}-window`}>
        {`${WINDOW_LABEL} · ${WINDOW_UTC}`}
      </label>
      <select
        id={`${id}-window`}
        value={shown}
        onChange={(event) => {
          const value = event.target.value;
          if (value === OTHER) {
            const start = window === 'all' ? '' : String(window.days);
            setTyping(true);
            setText(start);
            const parsed = readDays(start);
            onProblem?.(parsed.ok ? undefined : parsed.reason);
            return;
          }
          setTyping(false);
          onProblem?.(undefined);
          onChange(value === ALL ? 'all' : { days: Number(value) });
        }}
      >
        {PRESETS.map((days) => (
          <option key={days} value={String(days)}>
            {windowDaysLabel(days)}
          </option>
        ))}
        <option value={ALL}>{WINDOW_ALL_TIME}</option>
        <option value={OTHER}>{custom ? windowDaysLabel(window.days) : WINDOW_OTHER}</option>
      </select>
      {showNumber ? (
        <>
          <label className="supernode-label" htmlFor={`${id}-days`}>
            {WINDOW_DAYS_LABEL}
          </label>
          <input
            id={`${id}-days`}
            inputMode="numeric"
            value={typing ? text : custom ? String(window.days) : ''}
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : `${id}-problem`}
            onChange={(event) => {
              const next = event.target.value;
              setTyping(true);
              setText(next);
              const parsed = readDays(next);
              onProblem?.(parsed.ok ? undefined : parsed.reason);
              if (parsed.ok) onChange({ days: parsed.days });
            }}
          />
          {problem === undefined ? null : (
            <p id={`${id}-problem`} className="neighbor-types-note" role="alert">
              {problem}
            </p>
          )}
        </>
      ) : null}
      <span className="neighbor-types-note" data-window={windowKey(window)}>
        {dated === 'none' ? WINDOW_NOTE_NONE : window === 'all' ? WINDOW_NOTE_ALL : WINDOW_NOTE_DAYS}
        {window !== 'all' && dated !== 'none' && range !== undefined ? ` ${windowDatesText(range.from, range.to)}.` : ''}
      </span>
    </div>
  );
}
