import type { SaveState } from '../state/investigation-state.js';

const HOURS_AND_MINUTES = /T(\d{2}:\d{2})/;

export function saveStateText(save: SaveState): string {
  if (save.kind === 'unsaved') return 'Unsaved';
  const time = HOURS_AND_MINUTES.exec(new Date(save.at).toISOString())?.[1];
  return time === undefined ? 'Saved' : `Saved ${time} UTC`;
}
