import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec {
  readonly id: string;
  readonly label: ReactNode;
  /** A tab that a part of its panel is wrong in, marked by a word as well as by colour. */
  readonly marked?: boolean;
  /** What a screen reader adds to the tab's name (PB20): where the step is and whether it is valid, or how many conditions or problems a part has. */
  readonly description?: string;
}

interface Props {
  readonly label: string;
  readonly idPrefix: string;
  readonly tabs: readonly TabSpec[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  /** What follows the tabs in the same row and is not one of them (the + Step button). */
  readonly trailing?: ReactNode;
  readonly className?: string;
  /** `manual`: the arrow keys move the focus and Enter or Space selects (the step tabs of PB20); `automatic`: moving selects. */
  readonly activation?: 'manual' | 'automatic';
}

export const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/** A row of tabs: one tab is in the tab order, the arrow keys, Home and End move between them and select, and each tab names the panel it controls. */
export function TabList({ label, idPrefix, tabs, selected, onSelect, trailing, className, activation = 'automatic' }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.findIndex((tab) => tab.id === selected);
    const move = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (move === undefined || tabs.length === 0) return;
    event.preventDefault();
    const next = tabs[(move + tabs.length) % tabs.length];
    if (next === undefined) return;
    if (activation === 'automatic') onSelect(next.id);
    const target = list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idPrefix, next.id))}`);
    target?.focus();
  };
  return (
    <div className={className === undefined ? 'editor-tabs' : `editor-tabs ${className}`}>
      <div role="tablist" aria-label={label} className="editor-tablist" ref={list} onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={tab.id === selected}
            aria-controls={panelId(idPrefix, tab.id)}
            aria-describedby={tab.description === undefined ? undefined : `${tabId(idPrefix, tab.id)}-description`}
            tabIndex={tab.id === selected ? 0 : -1}
            className="editor-tab"
            data-marked={tab.marked === true ? 'true' : undefined}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) =>
        tab.description === undefined ? null : (
          <span key={tab.id} hidden id={`${tabId(idPrefix, tab.id)}-description`}>
            {tab.description}
          </span>
        ),
      )}
      {trailing}
    </div>
  );
}
