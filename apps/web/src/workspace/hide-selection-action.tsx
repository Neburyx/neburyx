import { useEffect } from 'react';
import { useClientState } from '../state/context.js';
import { hideEntities } from '../canvas/hide-commands.js';
import { SELECTION_ACTION_ORDER, useSelectionActionRegistryWhenProvided } from './selection-actions.js';

/** Puts *Hide* on the selection bar: it hides the selected entities by the command that the menu and the Del key run. Draws nothing. */
export function HideSelectionAction() {
  const registry = useSelectionActionRegistryWhenProvided();
  const state = useClientState();
  useEffect(() => {
    if (registry === undefined) return undefined;
    return registry.register({
      id: 'hide',
      order: SELECTION_ACTION_ORDER.hide,
      label: 'Hide',
      icon: <span className="icon icon-hide" aria-hidden="true" />,
      run: (selection) => hideEntities(state, selection),
    });
  }, [registry, state]);
  return null;
}
