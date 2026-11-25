import { createStore, type ReadableStore } from '../state/store.js';
import { ANSWER_WAIT_MS } from '../windows/window-channel.js';


type SelectionPhase = 'pending' | 'highlighted' | 'no-window' | 'not-on-canvas';

/** The one row of the page that holds a state of this feature: the key of its element and where it stands. */
export interface RowSelection {
  readonly key: string;
  readonly phase: SelectionPhase;
}

/** What the page needs of the channel between windows: whether a graph window is open, a way to send one key and to hear the answer. */
export interface SelectionLink {
  readonly graphOpen: () => boolean;
  /** Sends the key and returns the id the answer will carry; undefined where nothing could be sent. */
  readonly send: (key: string) => string | undefined;
  readonly onAnswer: (listener: (answer: { readonly requestId: string; readonly windowId: string; readonly onCanvas: readonly string[] }) => void) => () => void;
}

export interface SourceSelection {
  readonly state: ReadableStore<RowSelection | undefined>;
  /** Presses a row whose element the investigation holds: with a graph window open the key goes to it and the row waits for its answer; with none the row says it is selected and that nothing was highlighted. */
  select(key: string): void;
  /** The graph windows that are open now: a highlight stands only while a window that reported the element on its canvas is among them. */
  graphWindowsChanged(open: ReadonlySet<string>): void;
  dispose(): void;
}

export function createSourceSelection(link: SelectionLink, timers: { readonly set: (run: () => void, ms: number) => unknown; readonly clear: (id: unknown) => void } = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }): SourceSelection {
  const state = createStore<RowSelection | undefined>(undefined);
  let timer: unknown;
  let waiting: string | undefined;
  let sending = false;
  let early: string[] = [];
  let reporters = new Set<string>();
  let open: ReadonlySet<string> = new Set();
  const stop = (): void => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const apply = (requestId: string, windowId: string, onCanvas: readonly string[]): void => {
    const current = state.getState();
    if (current === undefined || waiting === undefined || requestId !== waiting) return;
    if (current.phase !== 'pending' && current.phase !== 'not-on-canvas' && current.phase !== 'highlighted') return;
    if (onCanvas.includes(current.key)) {
      reporters.add(windowId);
      state.setState({ key: current.key, phase: 'highlighted' });
      return;
    }
    if (current.phase === 'pending') state.setState({ key: current.key, phase: 'not-on-canvas' });
  };
  const stopListening = link.onAnswer((answer) => {
    if (sending) {
      early.push(JSON.stringify([answer.requestId, answer.windowId, answer.onCanvas]));
      return;
    }
    apply(answer.requestId, answer.windowId, answer.onCanvas);
  });
  return {
    state,
    select(key) {
      stop();
      waiting = undefined;
      reporters = new Set();
      if (!link.graphOpen()) {
        state.setState({ key, phase: 'no-window' });
        return;
      }
      sending = true;
      early = [];
      const requestId = link.send(key);
      sending = false;
      if (requestId === undefined) {
        state.setState({ key, phase: 'no-window' });
        return;
      }
      waiting = requestId;
      state.setState({ key, phase: 'pending' });
      for (const held of early) {
        const [id, windowId, onCanvas] = JSON.parse(held) as [string, string, readonly string[]];
        apply(id, windowId, onCanvas);
      }
      early = [];
      if (waiting === undefined) return;
      timer = timers.set(() => {
        timer = undefined;
        const current = state.getState();
        if (waiting !== requestId) return;
        waiting = undefined;
        if (current !== undefined && current.key === key && current.phase === 'pending') state.setState({ key, phase: 'no-window' });
      }, ANSWER_WAIT_MS);
    },
    graphWindowsChanged(now) {
      open = now;
      const current = state.getState();
      if (current === undefined) return;
      if (current.phase === 'highlighted' && ![...reporters].some((id) => open.has(id))) {
        stop();
        waiting = undefined;
        state.setState(undefined);
      } else if (current.phase === 'pending' && open.size === 0) {
        stop();
        waiting = undefined;
        state.setState(undefined);
      }
    },
    dispose() {
      stop();
      stopListening();
    },
  };
}
