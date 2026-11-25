import { useEffect, useRef } from 'react';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { elementKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { CHAT_SELECTION_NOTE, chatSelectionOf, noteKeyOf } from './chat-selection.js';
import { useAnnounceWindow, useWindowChannel, useWindowScope } from './use-window-channel.js';

/**
 * What the graph window does for the other windows of the person: it says that it is open, and when another window selects one element it selects that element on its own canvas if the canvas draws it, and answers which keys it has. An element the
 * canvas does not draw is neither selected nor added; a message that holds other than one key is not answered. It reads nothing from the source. The element a chat window selected carries a note under it while that selection stands: it goes with
 * any other selection and when no chat window of the person is open any more.
 */
export function GraphWindowLink() {
  useAnnounceWindow('graph');
  const state = useClientState();
  const channel = useWindowChannel(useWindowScope());
  const graph = useVisibleGraph();
  const latest = useRef(graph);
  latest.current = graph;
  const chat = chatSelectionOf(state);
  const chatKey = useStoreSelector(chat, (key) => key);
  const chatWindows = useStoreSelector(channel?.openWindows ?? NO_WINDOWS, (open) => open.get('assistant') ?? NO_IDS);
  useEffect(() => {
    if (channel === undefined) return undefined;
    return channel.onSelection(({ requestId, keys }) => {
      const [key] = keys;
      if (keys.length !== 1 || key === undefined) return;
      const drawn = drawnKeys(latest.current).has(key);
      if (drawn) {
        chat.setState(noteKeyOf(key, latest.current.nodes));
        state.presentation.select([key]);
      }
      channel.sendSelectionResult(requestId, drawn ? [key] : []);
    });
  }, [channel, state, chat]);
  useEffect(
    () =>
      state.presentation.view.subscribe(() => {
        const key = chat.getState();
        if (key === undefined) return;
        const selection = state.presentation.view.getState().selection;
        if (selection.size !== 1 || !selection.has(key)) chat.setState(undefined);
      }),
    [state, chat],
  );
  useEffect(() => {
    if (chatWindows.size === 0 && chat.getState() !== undefined) chat.setState(undefined);
  }, [chatWindows, chat]);
  if (chatKey === undefined) return null;
  const title = latest.current.nodes.find((node) => elementKey(node.ref) === chatKey)?.display.title;
  return (
    <p className="visually-hidden" role="status">
      {title === undefined || title === '' ? CHAT_SELECTION_NOTE : `${CHAT_SELECTION_NOTE}: ${title}`}
    </p>
  );
}

const NO_IDS: ReadonlySet<string> = new Set();
const NO_MAP: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const NO_WINDOWS = { getState: () => NO_MAP, subscribe: () => () => undefined } as const;
