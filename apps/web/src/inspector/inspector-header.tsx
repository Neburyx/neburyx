import { useState } from 'react';
import type { GraphNode } from '@neburyx/contracts';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { copiedIdOf } from '../workspace/copy-ids.js';
import { useMenuItems } from '../workspace/menu-registry.js';
import { useSelectionActions } from '../workspace/selection-actions.js';
import { MORE_ACTIONS } from './copy.js';
import { propertyText } from './property-text.js';

const HEADER_ACTIONS: readonly string[] = ['expand', 'pin', 'hide'];
const HIDE_ACTION = 'hide';
/** The node menu's items that the header's buttons already are. */
const HEADER_MENU_ITEMS: readonly string[] = ['expand-neighbors', 'pin-position', 'hide-from-view'];

function focusCanvas(): void {
  document.querySelector<HTMLElement>('.graph-canvas')?.focus({ preventScroll: true });
}

interface Props {
  readonly node: GraphNode;
  readonly keyOf: string;
  readonly typeName: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
}

export function InspectorHeader({ node, keyOf, typeName, closeLabel, onClose }: Props) {
  const state = useClientState();
  const profile = useProfileWhenProvided();
  const mask = useSessionMask();
  const actions = useSelectionActions();
  const menuItems = useMenuItems('node');
  useStoreSelector(state.presentation.view, (current) => current.pins);
  const [note, setNote] = useState<{ readonly key: string; readonly text: string } | undefined>(undefined);
  const entityType = profile?.entityTypes.find((entry) => entry.type === node.ref.entityType);
  const stateProperty = entityType?.stateProperty ?? undefined;
  const status = stateProperty === undefined ? undefined : node.properties.find((property) => property.key === stateProperty);
  const buttons = actions.filter((action) => HEADER_ACTIONS.includes(action.id));
  const hasMenu = menuItems.some((item) => !HEADER_MENU_ITEMS.includes(item.id));
  const id = copiedIdOf(node, profile, mask);
  return (
    <header className="inspector-header">
      <div className="inspector-heading">
        <div className="inspector-titles">
          <p className="inspector-caption">{typeName}</p>
          <h2 className="inspector-title">{node.display.title}</h2>
          <code className="inspector-ref">{id}</code>
        </div>
        <button type="button" className="legend-close" aria-label={closeLabel} onClick={onClose}>
          <span className="icon icon-clear" aria-hidden="true" />
        </button>
      </div>
      {status === undefined || stateProperty === undefined ? null : (
        <p className="inspector-status">
          <span className="inspector-status-value">{propertyText(status)}</span>
          <span className="inspector-status-caption">{`${stateProperty} from source`}</span>
        </p>
      )}
      <div className="inspector-actions">
        {buttons.map((action) => (
          <button
            key={action.id}
            type="button"
            className="inspector-action"
            onClick={() => {
              const text = action.run([keyOf]);
              setNote(typeof text === 'string' && text !== '' ? { key: keyOf, text } : undefined);
              if (action.id === HIDE_ACTION) focusCanvas();
            }}
          >
            {action.icon}
            {typeof action.label === 'function' ? action.label([keyOf], state) : action.label}
          </button>
        ))}
        {hasMenu ? (
          <button
            type="button"
            className="inspector-action inspector-more"
            aria-label={MORE_ACTIONS}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              state.presentation.setOpenMenu({ kind: 'node', key: keyOf, x: box.left, y: box.bottom, leaveOut: HEADER_MENU_ITEMS });
            }}
          >
            <span aria-hidden="true">···</span>
          </button>
        ) : null}
      </div>
      {note?.key === keyOf ? (
        <p className="inspector-note" role="status">
          {note.text}
        </p>
      ) : null}
    </header>
  );
}
