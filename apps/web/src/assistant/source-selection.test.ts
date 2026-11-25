import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_WAIT_MS } from '../windows/window-channel.js';
import { createSourceSelection, type SelectionLink } from './source-selection.js';

afterEach(() => vi.useRealTimers());

function setup(open = true) {
  vi.useFakeTimers();
  const sent: string[] = [];
  let counter = 0;
  let open_ = open;
  let listener: ((answer: { readonly requestId: string; readonly windowId: string; readonly onCanvas: readonly string[] }) => void) | undefined;
  const link: SelectionLink = {
    graphOpen: () => open_,
    send: (key) => {
      sent.push(key);
      counter += 1;
      return `r${counter}`;
    },
    onAnswer: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const selection = createSourceSelection(link);
  return { selection, sent, answer: (requestId: string, onCanvas: string[], windowId = 'w1') => listener?.({ requestId, windowId, onCanvas }), setOpen: (value: boolean) => (open_ = value) };
}

describe('the claim of a highlight when graph windows close', () => {
  const highlighted = (reports: readonly (readonly [string, boolean])[]) => {
    const h = setup();
    h.selection.graphWindowsChanged(new Set(reports.map(([id]) => id)));
    h.selection.select('k1', 'o1');
    for (const [id, has] of reports) h.answer('r1', has ? ['k1'] : [], id);
    return h;
  };

  it('goes when the window that reported the element closes and another open window never reported', () => {
    const h = setup();
    h.selection.graphWindowsChanged(new Set(['a', 'b']));
    h.selection.select('k1', 'o1');
    h.answer('r1', ['k1'], 'a');
    expect(h.selection.state.getState()?.phase).toBe('highlighted');
    h.selection.graphWindowsChanged(new Set(['b']));
    expect(h.selection.state.getState()).toBeUndefined();
  });

  it('goes when the window that reported the element closes and the other open window reported that it was not on its canvas', () => {
    const h = highlighted([['a', true], ['b', false]]);
    expect(h.selection.state.getState()?.phase).toBe('highlighted');
    h.selection.graphWindowsChanged(new Set(['b']));
    expect(h.selection.state.getState()).toBeUndefined();
  });

  it('stays while another open window also reported the element, and goes when the last such window closes', () => {
    const h = highlighted([['a', true], ['b', true]]);
    h.selection.graphWindowsChanged(new Set(['b']));
    expect(h.selection.state.getState()?.phase).toBe('highlighted');
    h.selection.graphWindowsChanged(new Set());
    expect(h.selection.state.getState()).toBeUndefined();
  });

  it('stays when a window that did not report closes', () => {
    const h = highlighted([['a', true], ['b', false]]);
    h.selection.graphWindowsChanged(new Set(['a']));
    expect(h.selection.state.getState()?.phase).toBe('highlighted');
  });
});

describe('the selection of a source row across windows', () => {
  it('sends the key and shows the highlight only after the graph window answers that it has the element', () => {
    const { selection, sent, answer } = setup();
    selection.select('k1', 'o1');
    expect(sent).toEqual(['k1']);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'pending' });
    answer('r1', ['k1']);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'highlighted' });
  });

  it('says not on the canvas when the window answers that it does not have the element, and never claims a highlight', () => {
    const { selection, answer } = setup();
    selection.select('k1', 'o1');
    answer('r1', []);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'not-on-canvas' });
  });

  it('takes the union of several windows: a window that does not hold the element never hides another that does, whichever answers first', () => {
    const { selection, answer } = setup();
    selection.select('k1', 'o1');
    answer('r1', []);
    expect(selection.state.getState()?.phase).toBe('not-on-canvas');
    answer('r1', ['k1']);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'highlighted' });
    selection.select('k1', 'o1');
    answer('r2', ['k1']);
    answer('r2', []);
    expect(selection.state.getState()?.phase).toBe('highlighted');
  });

  it('ignores an answer for another key and one that arrives when no request is waiting', () => {
    const { selection, answer } = setup();
    answer('r1', ['k1']);
    expect(selection.state.getState()).toBeUndefined();
    selection.select('k1', 'o1');
    answer('r9', ['k1']);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'pending' });
  });

  it('falls back to the no-window state when no answer comes within the wait', () => {
    const { selection } = setup();
    selection.select('k1', 'o1');
    vi.advanceTimersByTime(ANSWER_WAIT_MS - 1);
    expect(selection.state.getState()?.phase).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'no-window' });
  });

  it('sends nothing and says selected when no graph window is open', () => {
    const { selection, sent } = setup(false);
    selection.select('k1', 'o1');
    expect(sent).toEqual([]);
    expect(selection.state.getState()).toEqual({ key: 'k1', owner: 'o1', phase: 'no-window' });
  });

  it('holds one row at a time: a second press replaces the first and a late answer for the first is ignored', () => {
    const { selection, answer } = setup();
    selection.select('k1', 'o1');
    selection.select('k2', 'o1');
    answer('r1', ['k1']);
    expect(selection.state.getState()).toEqual({ key: 'k2', owner: 'o1', phase: 'pending' });
    answer('r2', ['k2']);
    expect(selection.state.getState()).toEqual({ key: 'k2', owner: 'o1', phase: 'highlighted' });
  });

  it('drops a highlight when the graph window closes, and leaves the no-window notice alone', () => {
    const { selection, answer } = setup();
    selection.select('k1', 'o1');
    answer('r1', ['k1']);
    selection.graphWindowsChanged(new Set());
    expect(selection.state.getState()).toBeUndefined();
    selection.select('k2', 'o1');
    vi.advanceTimersByTime(ANSWER_WAIT_MS);
    selection.graphWindowsChanged(new Set());
    expect(selection.state.getState()).toEqual({ key: 'k2', owner: 'o1', phase: 'no-window' });
  });
});
