import { ASSISTANT_PATH } from '../shell/navigation.js';

const NAME_PREFIX = 'neburyx-assistant-';

/** `unreachable`: the channel says a page is open but its window is not one this window can reach by name (a tab opened by hand is in another group of windows), so nothing is opened. */
export type PopOutResult = 'opened' | 'focused' | 'refused' | 'unreachable';

export interface PopOutDeps {
  readonly open: (url: string, name: string) => Window | null;
  /** Whether the channel says a page of the investigation is open in another window. */
  readonly pageOpenElsewhere: () => boolean;
}

/** The name a window holds when it shows the page of an investigation: the one name by which a second Pop out finds it. */
export function popOutName(investigationId: string): string {
  return `${NAME_PREFIX}${investigationId}`;
}

export function popOutAddress(investigationId: string): string {
  return `${ASSISTANT_PATH}/${encodeURIComponent(investigationId)}`;
}

const opened = new Map<string, Window>();

function emptyWindow(window: Window): boolean {
  try {
    return window.location.href === 'about:blank';
  } catch {
    return false;
  }
}

/** Opens the page of the investigation in a window of its own, or focuses the one that shows it, and never reloads a page that is open. */
export function popOut(investigationId: string, deps: PopOutDeps): PopOutResult {
  const held = opened.get(investigationId);
  if (held !== undefined && !held.closed) {
    held.focus();
    return 'focused';
  }
  opened.delete(investigationId);
  const name = popOutName(investigationId);
  if (deps.pageOpenElsewhere()) {
    const found = deps.open('', name);
    if (found !== null) {
      if (!emptyWindow(found)) {
        found.focus();
        opened.set(investigationId, found);
        return 'focused';
      }
      found.close();
      return 'unreachable';
    }
  }
  const created = deps.open(popOutAddress(investigationId), name);
  if (created === null) return 'refused';
  opened.set(investigationId, created);
  return 'opened';
}

/** Forgets the windows this window has opened: for a test that starts again. */
export function forgetOpenedWindows(): void {
  opened.clear();
}
