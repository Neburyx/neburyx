import { useState, type KeyboardEvent, type ComponentType } from 'react';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { elementKey, nodeRefOfKey } from '../state/keys.js';
import { useClientState, useLoadedGraph, useSessionMask, useVisibleGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { isUnmappedNode, NO_LONGER_MAPPED, UNMAPPED_TITLE } from '../draft/unmapped.js';
import { CLOSE_INSPECTOR, INSPECTOR_TITLE, UNMAPPED_INSPECTOR_TEXT } from './copy.js';
import { InspectorHeader } from './inspector-header.js';
import { inspectedKey } from './inspected.js';
import { InspectorContext, type Inspector } from './inspector.js';
import { useInspectorTabs } from './inspector-tabs.js';
import { useEntityRead } from './entity-read.js';

function focusCanvas(): void {
  document.querySelector<HTMLElement>('.graph-canvas')?.focus({ preventScroll: true });
}

function InspectorPanel({ inspector }: { readonly inspector: Inspector }) {
  const state = useClientState();
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  const visible = useVisibleGraph();
  const loaded = useLoadedGraph();
  const mask = useSessionMask();
  const profile = useProfileWhenProvided();
  const tabs = useInspectorTabs(inspector.tabs);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const anchor = useStoreSelector(inspector.anchor, (current) => current);
  const key = inspectedKey(selection, visible, anchor);
  const ref = key === undefined ? undefined : nodeRefOfKey(key);
  const node = key === undefined ? undefined : loaded.nodes.find((candidate) => elementKey(candidate.ref) === key);
  const unmapped = node !== undefined && isUnmappedNode(node);
  const read = useEntityRead(unmapped ? undefined : ref, mask);
  const tab = tabs.find((candidate) => candidate.id === chosen) ?? tabs[0];
  if (key === undefined || ref === undefined || node === undefined) return null;
  const shown = read.node ?? node;
  const close = (): void => {
    inspector.dismiss(key);
    focusCanvas();
  };
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = tabs.findIndex((candidate) => candidate.id === tab?.id);
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next === undefined) return;
    event.preventDefault();
    setChosen(next.id);
    queueMicrotask(() => document.getElementById(`inspector-tab-${next.id}`)?.focus());
  };
  if (unmapped) {
    return (
      <div
        className="inspector"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <header className="inspector-header">
          <div className="inspector-heading">
            <div className="inspector-titles">
              <p className="inspector-caption">{NO_LONGER_MAPPED}</p>
              <h2 className="inspector-title">{UNMAPPED_TITLE}</h2>
            </div>
            <button type="button" className="legend-close" aria-label={CLOSE_INSPECTOR} onClick={close}>
              <span className="icon icon-clear" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="inspector-body">
          <p>{UNMAPPED_INSPECTOR_TEXT}</p>
        </div>
      </div>
    );
  }
  const Content = tab?.content;
  const typeName = profile?.entityTypes.find((entry) => entry.type === ref.entityType)?.displayName ?? ref.entityType;
  return (
    <div
      className="inspector"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <InspectorHeader node={shown} keyOf={key} typeName={typeName} closeLabel={CLOSE_INSPECTOR} onClose={close} />
      <div className="inspector-tabs" role="tablist" aria-label={INSPECTOR_TITLE} onKeyDown={move}>
        {tabs.map((entry) => (
          <button key={entry.id} id={`inspector-tab-${entry.id}`} type="button" role="tab" className="inspector-tab" aria-selected={entry.id === tab?.id} aria-controls="inspector-tabpanel" tabIndex={entry.id === tab?.id ? 0 : -1} onClick={() => setChosen(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div id="inspector-tabpanel" role="tabpanel" aria-labelledby={tab === undefined ? undefined : `inspector-tab-${tab.id}`} className="inspector-body">
        {Content === undefined ? null : <Content key={key} node={shown} entity={ref} read={read} />}
      </div>
    </div>
  );
}

/** The content a panel registers: the inspector bound to the tabs it was made with. */
export function inspectorContent(inspector: Inspector): ComponentType {
  return function InspectorContent() {
    return (
      <InspectorContext.Provider value={inspector}>
        <InspectorPanel inspector={inspector} />
      </InspectorContext.Provider>
    );
  };
}
