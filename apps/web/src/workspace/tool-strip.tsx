import { useEffect, useRef } from 'react';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { FlyoutBoundary } from './flyout-boundary.js';
import { EXPLORE_TOOL_ID, useTools } from './tool-registry.js';

export function ToolStrip() {
  const state = useClientState();
  const tools = useTools();
  const openTool = useStoreSelector(state.presentation.view, (current) => current.openTool);
  const activeActions = useStoreSelector(state.presentation.view, (current) =>
    tools.filter((tool) => tool.kind.type === 'action' && tool.kind.isActive?.(current) === true).map((tool) => tool.id).join('\n'),
  );
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const root = useRef<HTMLDivElement>(null);
  const open = tools.find((tool) => tool.id === openTool?.id && tool.registration === openTool.registration && tool.kind.type === 'flyout');
  const flyoutOpen = open !== undefined;
  useEffect(() => {
    if (!flyoutOpen) return undefined;
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) === true) return;
      state.presentation.setOpenTool(undefined);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [flyoutOpen, state]);
  if (tools.length === 0) return null;
  const activeActionIds = activeActions === '' ? [] : activeActions.split('\n');
  // one tool is drawn active: the flyout while it is open, else the panel that is open, else Explore
  const active = open?.id ?? activeActionIds[0] ?? (tools.some((tool) => tool.id === EXPLORE_TOOL_ID) ? EXPLORE_TOOL_ID : undefined);
  const Flyout = open?.kind.type === 'flyout' ? open.kind.content : undefined;
  return (
    <div className="tool-strip" ref={root}>
      <div className="tool-strip-buttons" role="group" aria-label="Tools">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="tool-button"
            aria-label={tool.label}
            aria-haspopup={tool.kind.type === 'flyout' ? 'menu' : undefined}
            aria-expanded={tool.kind.type === 'flyout' ? tool.id === open?.id : undefined}
            aria-pressed={tool.kind.type === 'action' && tool.kind.isActive !== undefined ? activeActionIds.includes(tool.id) : undefined}
            data-active={tool.id === active ? 'true' : undefined}
            ref={(element) => {
              if (element === null) buttons.current.delete(tool.id);
              else buttons.current.set(tool.id, element);
            }}
            onClick={() => {
              if (tool.kind.type === 'action') tool.kind.activate();
              else state.presentation.setOpenTool(open?.id === tool.id ? undefined : { id: tool.id, registration: tool.registration });
            }}
          >
            {tool.icon}
          </button>
        ))}
      </div>
      {open !== undefined && Flyout !== undefined ? (
        <div
          className="tool-flyout-position"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' && event.key !== 'Tab') return;
            state.presentation.setOpenTool(undefined);
            buttons.current.get(open.id)?.focus();
          }}
        >
          <FlyoutBoundary key={open.id} onFailure={() => state.presentation.setOpenTool(undefined)}>
            <Flyout
              close={() => {
                state.presentation.setOpenTool(undefined);
                buttons.current.get(open.id)?.focus();
              }}
            />
          </FlyoutBoundary>
        </div>
      ) : null}
    </div>
  );
}
