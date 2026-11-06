import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useClientState } from '../state/context.js';
import { KeyBindingError, useKeyBindingRegistry } from '../workspace/key-binding-registry.js';
import { useWorkspacePresence } from '../workspace/workspace-presence.js';

export const SEARCH_PATH = '/search';
export const SEARCH_BINDING_ID = 'search';

/** What a page opened through the key does: put the focus in the search box and select its text. */
export const FOCUS_SEARCH = { focusSearch: true } as const;

export function focusSearchRequested(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'focusSearch' in state && state.focusSearch === true;
}

/**
 * Registers the Search key in the one key-binding registry, for the `app` scope: the key handler of the page shell and of the workspace run it, under their own rules (it is left
 * to the browser while the focus is in a text field, a menu or a dialog). In the workspace it opens the Search panel with its box focused, or focuses the box of an open one. From
 * any other page it opens the search page with the box focused; on the search page it focuses the box again and keeps the search that is shown.
 */
export function SearchShortcut() {
  const registry = useKeyBindingRegistry();
  const navigate = useNavigate();
  const location = useLocation();
  const state = useClientState();
  const presence = useWorkspacePresence();
  const here = useRef(location);

  useEffect(() => {
    here.current = location;
  }, [location]);

  useEffect(() => {
    const open = (): void => {
      if (presence?.shown.getState() === true) return state.presentation.requestSearch();
      const current = here.current;
      if (current.pathname === SEARCH_PATH) navigate({ pathname: SEARCH_PATH, search: current.search }, { replace: true, state: { ...(typeof current.state === 'object' && current.state !== null ? current.state : {}), ...FOCUS_SEARCH } });
      else navigate(SEARCH_PATH, { state: FOCUS_SEARCH });
    };
    try {
      return registry.register({ id: SEARCH_BINDING_ID, keys: ['mod+k'], label: 'Search', group: 'tools', order: 40, scope: 'app', run: open });
    } catch (error) {
      // a stand-in of a development page or a test already holds the key, and keeps it
      if (error instanceof KeyBindingError) return undefined;
      throw error;
    }
  }, [registry, navigate, state, presence]);

  return null;
}
