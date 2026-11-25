import { ASSISTANT_COPY } from './copy.js';
import type { RowSelection } from './source-selection.js';

/** What a source row of the page shows beside its label, and the notice under it: the words are fixed here, and a row that holds no state shows its own status. */
export interface RowState {
  readonly kind: 'idle' | 'pending' | 'highlighted' | 'selected' | 'not-on-canvas';
  readonly text: string;
  readonly notice?: string;
  readonly openGraph?: () => void;
}

export function rowStateOf(key: string, owner: string, selection: RowSelection | undefined, idleText: string, openGraph: () => void): RowState {
  if (selection === undefined || selection.key !== key || selection.owner !== owner) return { kind: 'idle', text: idleText };
  switch (selection.phase) {
    case 'pending':
      return { kind: 'pending', text: idleText };
    case 'highlighted':
      return { kind: 'highlighted', text: ASSISTANT_COPY.highlightedInGraph };
    case 'no-window':
      return { kind: 'selected', text: ASSISTANT_COPY.selected, notice: ASSISTANT_COPY.noGraphWindow, openGraph };
    case 'not-on-canvas':
      return { kind: 'not-on-canvas', text: ASSISTANT_COPY.notOnCanvas };
  }
}
