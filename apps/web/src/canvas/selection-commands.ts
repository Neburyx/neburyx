import type { ClientState } from '../state/client-state.js';
import { drawnEntityKeys } from './hide-commands.js';

export const SELECTION_COMMAND_IDS = ['select-all', 'invert-selection', 'clear-selection'] as const;

export type SelectionCommandId = (typeof SELECTION_COMMAND_IDS)[number];

const drawnEntities = (state: ClientState): string[] => [...drawnEntityKeys(state)];

/** The one definition of each command; the tool strip, the key bindings and the canvas menu run them by id. Relationships are never selected by a command. */
const SELECTION_COMMANDS: Readonly<Record<SelectionCommandId, (state: ClientState) => void>> = {
  'select-all': (state) => state.presentation.select(drawnEntities(state)),
  'invert-selection': (state) => {
    const selected = state.presentation.view.getState().selection;
    state.presentation.select(drawnEntities(state).filter((key) => !selected.has(key)));
  },
  'clear-selection': (state) => {
    if (state.presentation.view.getState().selection.size > 0) state.presentation.select([]);
  },
};

export function runSelectionCommand(state: ClientState, id: SelectionCommandId): void {
  SELECTION_COMMANDS[id](state);
}
