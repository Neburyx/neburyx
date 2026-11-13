import type { Count, ElementRef } from '@neburyx/contracts';
import type { ExpandStore, TypeProgress } from '../api/expand-store.js';
import type { ExpandWindow } from '../api/expand-window.js';
import { degreeCountText } from './degree-text.js';
import { WINDOW_NOT_COUNTED, windowCountLine, windowEverythingLoaded, windowNotFilteredText, windowUndatedText } from './expand-copy.js';

/** The window a chain was read with, when it narrowed what the chain brings: a number of days that the server says it applied to some relationship type. All time, a window that applied to none, and an answer that says nothing of a window narrow nothing. */
export function narrowingWindowOf(chainWindow: ExpandWindow | undefined, progress: TypeProgress | undefined): { readonly days: number } | undefined {
  if (chainWindow === undefined || chainWindow === 'all') return undefined;
  return progress?.window === undefined || progress.window.applied === 'none' ? undefined : chainWindow;
}

export interface WindowStatus {
  /** The count of the chain's first page for the window, said as a count for the window with its quality. */
  readonly count: string | undefined;
  /** What the window did not do: the types it did not apply to, and the relationships with no date. */
  readonly notes: readonly string[];
  /** The window, when it left nothing: no relationship of the type lies in it and no page follows. */
  readonly empty: { readonly days: number } | undefined;
  /** Said when the chain has ended and everything of the window is loaded. */
  readonly ended: string | undefined;
}

const isWindowCount = (count: Count | undefined): count is Count => count !== undefined && count.scope === 'expand:window';

/** What the controls say about the window of one neighbor type's chain: its count, its notes and whether everything in it is loaded. */
export function windowStatusOf(chainWindow: ExpandWindow | undefined, progress: TypeProgress | undefined, filtered = false): WindowStatus | undefined {
  const window = narrowingWindowOf(chainWindow, progress);
  if (window === undefined || progress === undefined) return undefined;
  const applied = progress.window;
  const notAppliedTo = applied?.notAppliedTo ?? [];
  const matching = progress.matching;
  const nothing = !progress.hasMore && !progress.restartNeeded && progress.inChain === 0;
  // with filters the filters may be what left nothing, so the window is not named as the cause
  const empty = nothing && !filtered ? window : undefined;
  const count = empty !== undefined ? undefined : !isWindowCount(matching) ? undefined : matching.value === undefined ? WINDOW_NOT_COUNTED : windowCountLine(window, notAppliedTo, degreeCountText(matching));
  const notes = [
    ...(notAppliedTo.length === 0 ? [] : [windowNotFilteredText(notAppliedTo)]),
    ...(applied === undefined ? [] : applied.undatedLeftOut === 0 ? [] : [windowUndatedText(applied.undatedLeftOut)]),
  ];
  return { count, notes, empty, ended: !nothing && !progress.hasMore && !progress.restartNeeded ? windowEverythingLoaded(window) : undefined };
}

/** Widens a chain that the window left empty to all time in one step: the same ask (relationship types, filters, rank) with only the window changed. */
export function showAllTime(expansions: ExpandStore, node: ElementRef, type: string): void {
  const chain = expansions.refinementOf(node, type);
  expansions.setWindow(node, 'all');
  void expansions.load(node, { first: [type], more: [], relTypes: expansions.relTypesOf(node, type), refinement: { filters: chain?.filters ?? [], rank: chain?.rank, window: 'all' } });
}
