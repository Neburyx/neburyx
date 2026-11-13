import { LINK_COPY, leavingText } from './copy.js';
import { PopupMenu } from './popup-menu.js';
import type { Direction, TypeOption } from './model.js';

interface Props {
  readonly from: string;
  readonly direction: Direction;
  readonly options: readonly TypeOption[];
  readonly chosen: readonly string[];
  readonly full: boolean;
  readonly nameOf: (type: string | undefined) => string;
  readonly onToggle: (option: TypeOption) => void;
}

/**
 * The menu that adds relationship types to a step (frame PB3): the types that leave the step's start in its direction, each with the type it leads to and whether the mapping gives it a date, the chosen ones ticked.
 * It stays open while types are ticked; Space or Enter ticks.
 */
export function AddTypeMenu({ from, direction, options, chosen, full, nameOf, onToggle }: Props) {
  const heading = leavingText(nameOf(from), direction);
  return (
    <PopupMenu button={LINK_COPY.addType} label={heading}>
      {() => (
        <>
          <p className="popup-menu-heading">{heading}</p>
          {options.map((option) => {
            const ticked = chosen.includes(option.type);
            const blocked = !ticked && full;
            return (
              <div
                key={`${option.type}-${option.arrival}`}
                role="menuitemcheckbox"
                aria-checked={ticked}
                aria-disabled={blocked ? true : undefined}
                tabIndex={-1}
                className="popup-menu-item"
                onClick={() => !blocked && onToggle(option)}
                onKeyDown={(event) => {
                  if ((event.key === ' ' || event.key === 'Enter') && !blocked) {
                    event.preventDefault();
                    onToggle(option);
                  }
                }}
              >
                <span aria-hidden="true" className="popup-menu-tick">
                  {ticked ? '✓' : ''}
                </span>
                <span className="popup-menu-type">{option.type}</span>
                <span className="popup-menu-lead">{`→ ${nameOf(option.arrival)} · ${option.dated ? LINK_COPY.hasDate : LINK_COPY.noDate}`}</span>
              </div>
            );
          })}
          {full ? <p className="popup-menu-note">{LINK_COPY.typesAtMost}</p> : null}
          <p className="popup-menu-note">{LINK_COPY.onlyMapped}</p>
        </>
      )}
    </PopupMenu>
  );
}
