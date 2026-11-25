import { useEffect, useRef } from 'react';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { useAnnounceWindow, useWindowChannel, useWindowScope } from './use-window-channel.js';

/**
 * What the graph window does for the other windows of the person: it says that it is open, and when another window selects one element it selects that element on its own canvas if the canvas draws it, and answers which keys it has. An element the
 * canvas does not draw is neither selected nor added; a message that holds other than one key is not answered. It reads nothing from the source.
 */
export function GraphWindowLink() {
  useAnnounceWindow('graph');
  const state = useClientState();
  const channel = useWindowChannel(useWindowScope());
  const graph = useVisibleGraph();
  const latest = useRef(graph);
  latest.current = graph;
  useEffect(() => {
    if (channel === undefined) return undefined;
    return channel.onSelection(({ requestId, keys }) => {
      const [key] = keys;
      if (keys.length !== 1 || key === undefined) return;
      const drawn = drawnKeys(latest.current).has(key);
      if (drawn) state.presentation.select([key]);
      channel.sendSelectionResult(requestId, drawn ? [key] : []);
    });
  }, [channel, state]);
  return null;
}
