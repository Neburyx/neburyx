import type { OwnedView } from '@neburyx/contracts';

/** What the Saved views tab leaves in the address state of the investigation it opens: the view to offer to restore. */
export interface RestoreViewIntent {
  readonly restoreView: { readonly id: string; readonly name: string };
}

export const intentOf = (view: Pick<OwnedView, 'id' | 'name'>): RestoreViewIntent => ({ restoreView: { id: view.id, name: view.name } });

/** The view an address state asks to restore, or `undefined` for any other state. */
export function restoreIntentOf(state: unknown): RestoreViewIntent['restoreView'] | undefined {
  if (typeof state !== 'object' || state === null || !('restoreView' in state)) return undefined;
  const view = state.restoreView;
  if (typeof view !== 'object' || view === null || !('id' in view) || !('name' in view)) return undefined;
  return typeof view.id === 'string' && typeof view.name === 'string' ? { id: view.id, name: view.name } : undefined;
}
