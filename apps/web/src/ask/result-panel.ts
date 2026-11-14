import type { AskRunResult, AskSummary } from '@neburyx/contracts';
import type { AddedOutcome } from '../patterns/add-to-graph.js';

/** What a run gave, as the result and summary views read it. */
export interface RunView {
  readonly outcome: 'complete' | 'partial';
  readonly result: AskRunResult;
  readonly summary?: AskSummary | undefined;
}

type ResultStage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'result'; readonly seconds: number; readonly outcome: 'complete' | 'partial'; readonly run: RunView; readonly added: AddedOutcome | undefined }
  | { readonly kind: 'heavy'; readonly seconds: number; readonly run: RunView; readonly token: string };

/** What the result and summary views need of the panel that holds them. */
export interface ResultPanel {
  readonly stage: ResultStage;
  readonly canAdd: boolean;
  addToGraph(): void;
  continueRun(): void;
  cancel(): void;
}

export const RESULT_COPY = {
  noAdd: 'This result has nothing to draw on the graph.',
  addToGraph: 'Add to graph',
  heavyNote: 'Continue reads one page. Cancel keeps the plan from running.',
  continue: 'Continue',
  cancel: 'Cancel',
} as const;
