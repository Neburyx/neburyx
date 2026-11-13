import { useEffect, useRef } from 'react';
import { useClientState } from '../state/context.js';
import { WorkspaceShell } from './workspace-shell.js';

/**
 * Explore with no investigation: the workspace as it stands, which Home opens on a source when a pattern is started with nothing open. Leaving it with nothing opened or added leaves nothing behind: the source it was bound to is let go.
 * The release is made after the page has gone, and cancelled when the page comes straight back (a development build mounts, unmounts and mounts again).
 */
export function BareExplore() {
  const state = useClientState();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    return () => {
      timer.current = setTimeout(() => state.unbindSource(), 0);
    };
  }, [state]);
  return <WorkspaceShell />;
}
