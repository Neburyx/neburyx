import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { FILTERS_PANEL_COPY, selectedRelationshipTypesText } from './filters-copy.js';

interface Props {
  readonly types: readonly string[];
  readonly off: ReadonlySet<string>;
  readonly onToggle: (type: string, off: boolean) => void;
}

/** The relationship types as a select that shows how many are on ("4 relationship types selected") and opens the list of them, each on or off. */
export function RelationshipTypesSelect({ types, off, onToggle }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    opener.current?.focus();
  };
  return (
    <div role="group" aria-label={FILTERS_PANEL_COPY.relationshipTypes} className="filters-section" onKeyDown={onKeyDown}>
      <span className="supernode-label" id={`${id}-label`}>
        {FILTERS_PANEL_COPY.relationshipTypes}
      </span>
      {types.length === 0 ? (
        <p className="neighbor-types-note">{FILTERS_PANEL_COPY.noRelationshipTypes}</p>
      ) : (
        <>
          <button type="button" ref={opener} className="select-control filter-select" aria-labelledby={`${id}-label ${id}-closed`} aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)}>
            <span id={`${id}-closed`}>{selectedRelationshipTypesText(types.filter((type) => !off.has(type)).length, types.length)}</span>
          </button>
          {open ? (
            <ul id={`${id}-list`} className="neighbor-types-list" aria-label={FILTERS_PANEL_COPY.relationshipTypes}>
              {types.map((type) => (
                <li key={type} className="neighbor-types-item">
                  <button type="button" role="checkbox" aria-checked={!off.has(type)} className="neighbor-types-row" onClick={() => onToggle(type, !off.has(type))}>
                    <span className="neighbor-types-check" aria-hidden="true" />
                    <span className="menu-label">{type}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
