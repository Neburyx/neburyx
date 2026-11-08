import { useEffect } from 'react';
import { useClientState } from '../state/context.js';
import { drawnEntityKeys } from '../canvas/hide-commands.js';
import { togglePin, willUnpin } from '../canvas/pin-commands.js';
import { SELECTION_ACTION_ORDER, useSelectionActionRegistryWhenProvided } from './selection-actions.js';

/** Puts *Pin* on the selection bar, reading *Unpin* when every selected entity is pinned: it runs the command that the menu and the P key run. Draws nothing. */
export function PinSelectionAction() {
  const registry = useSelectionActionRegistryWhenProvided();
  const state = useClientState();
  useEffect(() => {
    if (registry === undefined) return undefined;
    return registry.register({
      id: 'pin',
      order: SELECTION_ACTION_ORDER.pin,
      label: (selection) => {
        const drawn = drawnEntityKeys(state);
        return willUnpin(state, selection.filter((key) => drawn.has(key))) ? 'Unpin' : 'Pin';
      },
      icon: <span className="icon icon-pin" aria-hidden="true" />,
      run: (selection) => togglePin(state, selection),
    });
  }, [registry, state]);
  return null;
}
