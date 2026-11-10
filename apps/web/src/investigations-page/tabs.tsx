import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  /** Said with the tab's name by a screen reader, for a tab that is not available. */
  readonly unavailable?: string;
  readonly panel: ReactNode;
}

export const tabIdOf = (base: string, id: string): string => `${base}-tab-${id}`;
export const panelIdOf = (base: string, id: string): string => `${base}-panel-${id}`;

/** Tabs that follow the pattern: arrows, Home and End move and select, and the active panel is the only one drawn. */
export function Tabs({ idBase, label, tabs, active, onSelect }: { readonly idBase: string; readonly label: string; readonly tabs: readonly TabSpec[]; readonly active: string; readonly onSelect: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.id === active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (at + 1) % tabs.length : (at - 1 + tabs.length) % tabs.length;
    const target = tabs[next];
    if (target === undefined) return;
    onSelect(target.id);
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabIdOf(idBase, target.id))}`)?.focus();
  };
  const current = tabs.find((tab) => tab.id === active);
  return (
    <>
      <div ref={list} role="tablist" aria-label={label} className="investigations-tabs" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabIdOf(idBase, tab.id)}
            aria-selected={tab.id === active}
            aria-controls={panelIdOf(idBase, tab.id)}
            aria-disabled={tab.unavailable === undefined ? undefined : true}
            aria-describedby={tab.unavailable === undefined ? undefined : `${tabIdOf(idBase, tab.id)}-why`}
            tabIndex={tab.id === active ? 0 : -1}
            className={tab.unavailable === undefined ? 'investigations-tab' : 'investigations-tab investigations-tab-locked'}
            onClick={() => onSelect(tab.id)}
          >
            {tab.unavailable === undefined ? null : <svg aria-hidden="true" className="investigations-lock" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
                <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
              </svg>}
            {tab.label}
            {tab.unavailable === undefined ? null : (
              <span id={`${tabIdOf(idBase, tab.id)}-why`} className="visually-hidden">
                {tab.unavailable}
              </span>
            )}
          </button>
        ))}
      </div>
      {current === undefined ? null : (
        <div role="tabpanel" id={panelIdOf(idBase, current.id)} aria-labelledby={tabIdOf(idBase, current.id)} className="investigations-panel">
          {current.panel}
        </div>
      )}
    </>
  );
}
