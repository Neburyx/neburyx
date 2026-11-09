import { createStore, readable, type ReadableStore } from '../state/store.js';
import type { CompareSet } from './compare-set.js';

/** The comparison as it was chosen: its columns are fixed at that moment; an element that leaves the view is moved to `gone` and its column is taken out. */
export interface CompareTarget {
  readonly kind: CompareSet['kind'];
  /** The elements compared, with the titles they had when the comparison was opened (a note names an element that has left the view). */
  readonly columns: readonly { readonly key: string; readonly title: string }[];
  readonly selected: number;
  /** The keys of the elements selected beyond the limit. */
  readonly left: readonly string[];
  /** The titles of the elements that have left the view since. */
  readonly gone: readonly string[];
}

export interface Compare {
  readonly target: ReadableStore<CompareTarget | undefined>;
  /** Counts the choices that opened the comparison, so the panel takes the focus for each and for nothing else. */
  readonly choices: ReadableStore<number>;
  /** Opens the comparison on a set the person chose; `opener` is where the focus goes back to when it closes. */
  open(target: CompareTarget, opener?: HTMLElement | null): void;
  /** Takes the columns of the elements that have left the view out and notes them. */
  drop(keys: readonly string[]): void;
  /** Closes it. Without `restoreFocus` the focus stays where it is (another panel has taken the dock). */
  close(restoreFocus?: boolean): void;
  /** Runs before a comparison opens, so what else holds the dock can let go of it. */
  onOpening(listener: () => void): () => void;
}

function focusCanvas(): void {
  document.querySelector<HTMLElement>('.graph-canvas')?.focus({ preventScroll: true });
}

export function createCompare(): Compare {
  const target = createStore<CompareTarget | undefined>(undefined);
  const choices = createStore(0);
  const listeners = new Set<() => void>();
  let opener: HTMLElement | null = null;
  return {
    target: readable(target),
    choices: readable(choices),
    open(next, from = null) {
      for (const listener of [...listeners]) listener();
      opener = from ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      target.setState(next);
      choices.setState(choices.getState() + 1);
    },
    drop(keys) {
      const held = target.getState();
      if (held === undefined) return;
      const leaving = held.columns.filter((column) => keys.includes(column.key));
      if (leaving.length === 0) return;
      target.setState({ ...held, columns: held.columns.filter((column) => !keys.includes(column.key)), gone: [...held.gone, ...leaving.map((column) => column.title)] });
    },
    close(restoreFocus = true) {
      const back = opener;
      opener = null;
      if (target.getState() === undefined) return;
      target.setState(undefined);
      if (!restoreFocus) return;
      if (back !== null && back.isConnected) back.focus();
      else focusCanvas();
    },
    onOpening(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
