import { windowKey, type ExpandWindow } from '../api/expand-window.js';
import { WINDOW_ALL_TIME, WINDOW_NOTE_ALL, WINDOW_NOTE_DAYS, WINDOW_NOTE_NONE, WINDOW_PREFILLED, windowDatesText } from './expand-copy.js';
import { WindowPicker } from './window-picker.js';

interface WindowFieldProps {
  readonly window: ExpandWindow;
  /** The window is the Filters panel's time window, which the person has not chosen over. */
  readonly prefilled?: boolean;
  readonly onChange: (window: ExpandWindow) => void;
  /** The two UTC instants the server resolved the window to in the last answer for this node; the dates are shown from them only. */
  readonly range?: { readonly from: string; readonly to: string } | undefined;
  /** Whether the relationship types the controls now ask for have an observed time: all, some or none (from the source profile). */
  readonly dated: 'all' | 'some' | 'none';
  /** Told whenever the days typed are not a valid number, so that the controls send nothing until they are. */
  readonly onProblem?: ((problem: string | undefined) => void) | undefined;
}

/** The time window of an expansion: the last 7 days until a person chooses another number of days, dates or all time. */
export function ExpandWindowField({ window, prefilled = false, onChange, range, dated, onProblem }: WindowFieldProps) {
  return (
    <div className="supernode-field">
      <WindowPicker window={window} onChange={onChange} allLabel={WINDOW_ALL_TIME} onProblem={onProblem} />
      <span className="neighbor-types-note" data-window={windowKey(window)}>
        {dated === 'none' ? WINDOW_NOTE_NONE : window === 'all' ? WINDOW_NOTE_ALL : WINDOW_NOTE_DAYS}
        {window !== 'all' && dated !== 'none' && range !== undefined ? ` ${windowDatesText(range.from, range.to)}.` : ''}
      </span>
      {prefilled ? <span className="neighbor-types-note">{WINDOW_PREFILLED}</span> : null}
    </div>
  );
}
