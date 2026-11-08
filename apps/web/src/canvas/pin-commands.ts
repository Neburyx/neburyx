import type { ClientState } from '../state/client-state.js';
import { drawnEntityKeys, selectedEntities } from './hide-commands.js';
import { formatNumber } from '../workspace/scope-text.js';

const counted = (count: number): string => `${formatNumber(count)} ${count === 1 ? 'entity' : 'entities'}`;

/** What a menu opened on `key` acts on: every selected drawn entity when the entity is one of them, otherwise the entity alone; nothing when it is not drawn. */
export function pinTargetsOf(state: ClientState, selection: readonly string[], key: string | undefined): readonly string[] {
  const drawn = drawnEntityKeys(state);
  if (key === undefined || !drawn.has(key)) return [];
  return selection.includes(key) ? selection.filter((candidate) => drawn.has(candidate)) : [key];
}

/** True when every target is pinned, so that the command would release them. */
export function willUnpin(state: ClientState, keys: readonly string[]): boolean {
  const { pins } = state.presentation.view.getState();
  return keys.length > 0 && keys.every((key) => pins.has(key));
}

/** The one command behind the menu, the P key and the action bar: when every drawn target is pinned it unpins them, otherwise it pins those that are not, and tells a screen reader how many changed. Relationships and entities that are not drawn are ignored. */
export function togglePin(state: ClientState, keys: readonly string[]): void {
  const drawn = drawnEntityKeys(state);
  const targets = [...new Set(keys)].filter((key) => drawn.has(key));
  if (targets.length === 0) return;
  const { pins } = state.presentation.view.getState();
  if (willUnpin(state, targets)) {
    state.presentation.unpin(targets);
    state.presentation.announceMove(`Unpinned ${counted(targets.length)}.`);
    return;
  }
  const changed = targets.filter((key) => !pins.has(key));
  state.presentation.pin(changed);
  state.presentation.announceMove(`Pinned ${counted(changed.length)}.`);
}
