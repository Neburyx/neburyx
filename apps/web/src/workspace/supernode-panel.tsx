import { useEffect, useRef } from 'react';
import { nodeRefOfKey } from '../state/keys.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { CLOSE_PANEL, PANEL_TITLE } from './expand-copy.js';
import { useExpandStoreWhenProvided } from './expand-context.js';
import { NodeCard } from './node-card.js';
import { ExpandForm, PANEL_FIRST_CONTROL } from './expand-form.js';

const FOCUS_ATTRIBUTE = PANEL_FIRST_CONTROL;

/** Puts the focus back on the canvas, where the panel was opened from. */
function focusCanvas(): void {
  document.querySelector<HTMLElement>('.graph-canvas')?.focus({ preventScroll: true });
}

/** The panel Expand relationships, about the node the presentation state names: its header, and the controls that choose what to load. */
export function SupernodePanel() {
  const state = useClientState();
  const open = useStoreSelector(state.presentation.view, (current) => current.supernodePanel);
  const graph = useLoadedGraph();
  const profile = useProfileWhenProvided();
  const root = useRef<HTMLDivElement>(null);
  const ref = open === undefined ? undefined : nodeRefOfKey(open.key);
  const title = ref === undefined ? undefined : graph.nodes.find((node) => node.ref.entityType === ref.entityType && node.ref.stableId === ref.stableId)?.display.title;
  const typeName = ref === undefined ? undefined : (profile?.entityTypes.find((entry) => entry.type === ref.entityType)?.displayName ?? ref.entityType);
  const openedFor = open?.key;
  const expansions = useExpandStoreWhenProvided();
  useEffect(() => {
    if (openedFor === undefined) return;
    const opened = nodeRefOfKey(openedFor);
    // a node the person opened is one whose aggregate nodes may be drawn
    if (opened !== undefined) expansions?.touch(opened);
    // the menu that opened the panel gives the focus back to the canvas after it ran; the panel takes it after that
    root.current?.querySelector<HTMLElement>(`[${FOCUS_ATTRIBUTE}]`)?.focus();
  }, [openedFor, expansions]);
  const close = (): void => {
    state.presentation.setSupernodePanel(undefined);
    focusCanvas();
  };
  if (open === undefined) return null;
  return (
    <div
      className="supernode-panel"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div className="supernode-header">
        <div className="supernode-titles">
          <h2 className="supernode-heading">{PANEL_TITLE}</h2>
          <p className="supernode-node">{title === undefined ? typeName : `${title} · ${typeName}`}</p>
        </div>
        <button type="button" className="legend-close" aria-label={CLOSE_PANEL} onClick={close}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      {ref === undefined ? null : <ExpandForm key={`${open?.key}|${open?.neighborType ?? ''}`} node={ref} only={open?.neighborType} />}
      {ref === undefined ? null : <NodeCard node={ref} />}
    </div>
  );
}
