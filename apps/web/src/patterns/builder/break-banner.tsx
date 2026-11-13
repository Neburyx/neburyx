import { BREAK_COPY, breakText, breakTitle } from './copy.js';
import type { Break, Undo } from './model.js';

interface Props {
  readonly breaks: readonly Break[];
  readonly undo: Undo | undefined;
  readonly nameOf: (type: string | undefined) => string;
  readonly onUndo: () => void;
}

/** What a change left unfollowed by the mapping, each part in a sentence, with what is not done for the person and, when the change can be taken back, Undo change. It goes by itself when the last is fixed. */
export function BreakBanner({ breaks, undo, nameOf, onUndo }: Props) {
  if (breaks.length === 0) return null;
  return (
    <div className="patterns-state pattern-breaks" data-tone="warning" role="group" aria-label="Changes that break the pattern">
      <p className="pattern-breaks-title">{breakTitle(undo?.changed, breaks.length)}</p>
      <ul className="pattern-breaks-list">
        {breaks.map((found, index) => (
          <li key={index}>{breakText(found, nameOf)}</li>
        ))}
      </ul>
      <p>{undo === undefined ? BREAK_COPY.fixEach : BREAK_COPY.nothingRemoved}</p>
      {undo === undefined ? null : (
        <button type="button" className="secondary" onClick={onUndo}>
          {BREAK_COPY.undo}
        </button>
      )}
    </div>
  );
}
