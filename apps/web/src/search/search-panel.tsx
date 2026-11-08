import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { useProfile } from '../canvas/profile-context.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import type { SearchTab } from '../state/presentation-state.js';
import { useStoreSelector } from '../state/store.js';
import { AddFromSourceTab } from './add-tab.js';
import { SEARCH_PANEL_ID } from './search-panel-binder.js';
import { useContextEpoch } from './use-context-epoch.js';
import { entitiesOnCanvas, findOnCanvas, type OnCanvasRow } from './on-canvas.js';
import { onCanvasTabText, SEARCH_PANEL_COPY, selectedNote } from './copy.js';
import { focusSearchTool } from './search-tool.js';

const TAB_ORDER: readonly SearchTab[] = ['canvas', 'source'];

function OnCanvasTab({ box, id, labelledBy, hidden }: { readonly box: React.RefObject<HTMLInputElement | null>; readonly id: string; readonly labelledBy: string; readonly hidden: boolean }) {
  const state = useClientState();
  const graph = useVisibleGraph();
  const profile = useProfile();
  const canvas = useCanvasCommands();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const rows = findOnCanvas(graph, profile, text);
  const choose = (row: OnCanvasRow): void => {
    state.presentation.select([row.key]);
    canvas?.centerOn(row.key);
    setNote(selectedNote(row.title));
  };
  return (
    <div role="tabpanel" id={id} aria-labelledby={labelledBy} className="search-tabpanel" hidden={hidden}>
      <input ref={box} type="search" className="search-panel-box" aria-label={SEARCH_PANEL_COPY.onCanvasBoxLabel} autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} />
      {text === '' ? <p className="search-panel-note">{SEARCH_PANEL_COPY.onCanvasHint}</p> : rows.length === 0 ? <p role="status" className="search-panel-note">{SEARCH_PANEL_COPY.onCanvasNone}</p> : null}
      {rows.length === 0 ? null : (
        <ul className="search-panel-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <button type="button" className="search-panel-row" onClick={() => choose(row)}>
                <span className="search-panel-row-title">{row.title}</span>
                <span className="search-panel-row-type">{[row.typeName, ...(row.id === undefined || row.id === row.title ? [] : [row.id])].join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="search-panel-status">
        {note}
      </p>
    </div>
  );
}

export function SearchPanel() {
  const state = useClientState();
  const graph = useVisibleGraph();
  const epoch = useContextEpoch(state);
  const root = useRef<HTMLDivElement>(null);
  const collapsed = useStoreSelector(state.presentation.view, (current) => current.collapsedPanels.get(SEARCH_PANEL_ID));
  const focusRequests = useStoreSelector(state.presentation.view, (current) => current.searchFocus);
  const tab = useStoreSelector(state.presentation.view, (current) => current.searchTab);
  const canvasBox = useRef<HTMLInputElement>(null);
  const sourceBox = useRef<HTMLInputElement>(null);
  const canvasTab = useId();
  const sourceTab = useId();
  const canvasPanel = useId();
  const sourcePanel = useId();
  const tabs: readonly { readonly id: SearchTab; readonly tabId: string; readonly panelId: string; readonly label: string }[] = [
    { id: 'canvas', tabId: canvasTab, panelId: canvasPanel, label: onCanvasTabText(entitiesOnCanvas(graph)) },
    { id: 'source', tabId: sourceTab, panelId: sourcePanel, label: SEARCH_PANEL_COPY.addLabel },
  ];

  const focusBoxOfTab = useRef(false);
  const wantsFocus = useRef(false);
  const focusBox = (): void => {
    const box = tab === 'canvas' ? canvasBox : sourceBox;
    box.current?.focus();
    box.current?.select();
  };

  useEffect(() => {
    wantsFocus.current = true;
  }, [focusRequests]);
  useEffect(() => {
    if (!wantsFocus.current) return;
    if (collapsed !== undefined) {
      state.presentation.setPanelCollapsed(SEARCH_PANEL_ID, collapsed, false);
      return;
    }
    wantsFocus.current = false;
    focusBox();
  }, [focusRequests, collapsed]);
  useEffect(() => {
    if (!focusBoxOfTab.current) return;
    focusBoxOfTab.current = false;
    focusBox();
  }, [tab]);

  const close = (): void => {
    state.presentation.setSearchOpen(false);
    focusSearchTool();
  };
  useEffect(() => {
    const frame = root.current?.closest('.panel-frame');
    if (frame === null || frame === undefined) return undefined;
    const closeOnEscape = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    frame.addEventListener('keydown', closeOnEscape);
    return () => frame.removeEventListener('keydown', closeOnEscape);
  }, []);
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TAB_ORDER[(TAB_ORDER.indexOf(tab) + step + TAB_ORDER.length) % TAB_ORDER.length];
    if (next === undefined) return;
    state.presentation.setSearchTab(next);
    requestAnimationFrame(() => document.getElementById(tabs.find((candidate) => candidate.id === next)?.tabId ?? '')?.focus());
  };
  return (
    <div className="search-panel" ref={root}>
      <div className="search-panel-header">
        <h2 className="search-panel-heading">{SEARCH_PANEL_COPY.title}</h2>
        <button type="button" className="legend-close" aria-label={SEARCH_PANEL_COPY.close} onClick={close}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      <div role="tablist" aria-label={SEARCH_PANEL_COPY.tabsLabel} className="search-tabs" onKeyDown={onTabKeyDown}>
        {tabs.map((entry) => (
          <button key={entry.id} type="button" role="tab" id={entry.tabId} aria-selected={entry.id === tab} aria-controls={entry.panelId} tabIndex={entry.id === tab ? 0 : -1} className="search-tab" data-selected={entry.id === tab} onClick={() => {
              focusBoxOfTab.current = true;
              state.presentation.setSearchTab(entry.id);
            }}>
            {entry.label}
          </button>
        ))}
      </div>
      <OnCanvasTab key={epoch} box={canvasBox} id={canvasPanel} labelledBy={canvasTab} hidden={tab !== 'canvas'} />
      <AddFromSourceTab epoch={epoch} box={sourceBox} id={sourcePanel} labelledBy={sourceTab} hidden={tab !== 'source'} />
    </div>
  );
}
