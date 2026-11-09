import type { EdgeRef } from '@neburyx/contracts';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { createEvidenceKindRegistry, kindOf, type EvidenceKindRegistry } from './evidence-kinds.js';

export interface Evidence {
  readonly kinds: EvidenceKindRegistry;
  /** The relationship the panel shows; the panel is open exactly while there is one. */
  readonly target: ReadableStore<EdgeRef | undefined>;
  /** Counts the choices that opened the panel on purpose, so the panel takes focus for those and not when it follows the selection. */
  readonly choices: ReadableStore<number>;
  /** Whether a registered kind builds the evidence of this reference. */
  offers(ref: EdgeRef): boolean;
  /** Opens the panel on a relationship by choice; false, and nothing opens, when no kind offers it. `opener` is where focus goes back to when the panel closes. */
  open(ref: EdgeRef, opener?: HTMLElement | null): boolean;
  /** Moves an open panel to another relationship, as the selection does; it never opens a closed panel and never takes focus. */
  follow(ref: EdgeRef): void;
  close(): void;
  /** Runs before a panel opens by choice, so what else holds the dock can let go of it. */
  onOpening(listener: () => void): () => void;
}

function focusCanvas(): void {
  document.querySelector<HTMLElement>('.graph-canvas')?.focus({ preventScroll: true });
}

export function createEvidence(): Evidence {
  const kinds = createEvidenceKindRegistry();
  const target = createStore<EdgeRef | undefined>(undefined);
  const choices = createStore(0);
  let opener: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  const offers = (ref: EdgeRef): boolean => kindOf(kinds.view.getState(), ref) !== undefined;
  return {
    kinds,
    target: readable(target),
    choices: readable(choices),
    offers,
    open(ref, from = null) {
      if (!offers(ref)) return false;
      for (const listener of [...listeners]) listener();
      opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      target.setState(ref);
      choices.setState(choices.getState() + 1);
      return true;
    },
    follow(ref) {
      if (target.getState() !== undefined && offers(ref)) target.setState(ref);
    },
    close() {
      const back = opener;
      opener = null;
      target.setState(undefined);
      if (back !== null && back.isConnected) back.focus();
      else focusCanvas();
    },
    onOpening(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
