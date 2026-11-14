import { useId, useState } from 'react';
import { readDays, type ExpandWindow } from '../api/expand-window.js';
import { readWindow } from '../patterns/builder/conditions.js';
import { WINDOW_DATES, WINDOW_DAYS_LABEL, WINDOW_FROM, WINDOW_LABEL, WINDOW_OTHER, WINDOW_TO, WINDOW_UTC, windowDaysLabel } from './expand-copy.js';

const PRESETS: readonly number[] = [7, 30, 90, 365];
const ALL = 'all';
const OTHER = 'other';
const DATES = 'dates';

type Typing = 'days' | 'dates' | undefined;

interface WindowPickerProps {
  readonly window: ExpandWindow;
  readonly onChange: (window: ExpandWindow) => void;
  /** What the choice with no window is called: "All time" for an expansion, "Any time" for the filter. */
  readonly allLabel: string;
  /** Told whenever what is typed is not a valid number of days or pair of dates, so that the controls send nothing until it is. */
  readonly onProblem?: ((problem: string | undefined) => void) | undefined;
  /** What the control is called; the Filters panel names it after the time property of the mapping. */
  readonly name?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly describedBy?: string | undefined;
}

/** A window chosen as a preset number of days, another number of days, the days from one UTC date to another, or no window. */
export function WindowPicker({ window, onChange, allLabel, onProblem, name = WINDOW_LABEL, disabled, describedBy }: WindowPickerProps) {
  const id = useId();
  const dayCount = window !== 'all' && 'days' in window ? window.days : undefined;
  const held = window !== 'all' && 'from' in window ? window : undefined;
  const custom = dayCount !== undefined && !PRESETS.includes(dayCount);
  const [typing, setTyping] = useState<Typing>(undefined);
  const [text, setText] = useState('');
  const [dates, setDates] = useState({ from: '', to: '' });
  const mode: Typing = typing ?? (held !== undefined ? 'dates' : custom ? 'days' : undefined);
  const shown = mode === 'dates' ? DATES : mode === 'days' ? OTHER : dayCount === undefined ? ALL : String(dayCount);
  const daysText = typing === 'days' ? text : custom ? String(dayCount) : '';
  const datesShown = typing === 'dates' ? dates : held ?? dates;
  const daysRead = mode === 'days' ? readDays(daysText) : undefined;
  const datesRead = mode === 'dates' ? readWindow({ kind: 'dates', from: datesShown.from, to: datesShown.to }) : undefined;
  const daysProblem = typing === 'days' && daysRead !== undefined && !daysRead.ok ? daysRead.reason : undefined;
  const datesProblem = typing === 'dates' && datesRead !== undefined && !datesRead.ok ? datesRead.reason : undefined;
  const tellDates = (next: { readonly from: string; readonly to: string }): void => {
    setTyping('dates');
    setDates(next);
    const read = readWindow({ kind: 'dates', from: next.from, to: next.to });
    onProblem?.(read.ok ? undefined : read.reason);
    if (read.ok && read.window !== undefined) onChange(read.window);
  };
  return (
    <>
      <label className="supernode-label" htmlFor={`${id}-window`}>
        {`${name} · ${WINDOW_UTC}`}
      </label>
      <select
        id={`${id}-window`}
        value={shown}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          const value = event.target.value;
          if (value === OTHER) {
            const start = dayCount === undefined ? '' : String(dayCount);
            setTyping('days');
            setText(start);
            const parsed = readDays(start);
            onProblem?.(parsed.ok ? undefined : parsed.reason);
            return;
          }
          if (value === DATES) {
            tellDates(held ?? { from: '', to: '' });
            return;
          }
          setTyping(undefined);
          onProblem?.(undefined);
          onChange(value === ALL ? 'all' : { days: Number(value) });
        }}
      >
        {PRESETS.map((days) => (
          <option key={days} value={String(days)}>
            {windowDaysLabel(days)}
          </option>
        ))}
        <option value={ALL}>{allLabel}</option>
        <option value={OTHER}>{custom ? windowDaysLabel(dayCount) : WINDOW_OTHER}</option>
        <option value={DATES}>{WINDOW_DATES}</option>
      </select>
      {mode === 'days' ? (
        <>
          <label className="supernode-label" htmlFor={`${id}-days`}>
            {WINDOW_DAYS_LABEL}
          </label>
          <input
            id={`${id}-days`}
            inputMode="numeric"
            value={daysText}
            aria-invalid={daysProblem !== undefined}
            aria-describedby={daysProblem === undefined ? undefined : `${id}-problem`}
            onChange={(event) => {
              const next = event.target.value;
              setTyping('days');
              setText(next);
              const parsed = readDays(next);
              onProblem?.(parsed.ok ? undefined : parsed.reason);
              if (parsed.ok) onChange({ days: parsed.days });
            }}
          />
        </>
      ) : null}
      {mode === 'dates' ? (
        <>
          <label className="supernode-label" htmlFor={`${id}-from`}>
            {WINDOW_FROM}
          </label>
          <input id={`${id}-from`} inputMode="numeric" placeholder="2026-03-01" value={datesShown.from} aria-invalid={datesProblem !== undefined} aria-describedby={datesProblem === undefined ? undefined : `${id}-problem`} onChange={(event) => tellDates({ from: event.target.value, to: datesShown.to })} />
          <label className="supernode-label" htmlFor={`${id}-to`}>
            {WINDOW_TO}
          </label>
          <input id={`${id}-to`} inputMode="numeric" placeholder="2026-03-31" value={datesShown.to} aria-invalid={datesProblem !== undefined} aria-describedby={datesProblem === undefined ? undefined : `${id}-problem`} onChange={(event) => tellDates({ from: datesShown.from, to: event.target.value })} />
        </>
      ) : null}
      {daysProblem === undefined && datesProblem === undefined ? null : (
        <p id={`${id}-problem`} className="neighbor-types-note" role="alert">
          {daysProblem ?? datesProblem}
        </p>
      )}
    </>
  );
}
