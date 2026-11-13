export const PLAN_COPY = {
  title: 'Review before running',
  readOnly: 'Read-only · same limits as manual exploration',
  defaults: 'Anything not shown is filled in by the source’s own defaults.',
  run: 'Run',
  edit: 'Edit',
  cancel: 'Cancel',
  ready: 'The plan is ready. Nothing has run.',
  running: 'Running…',
  continuing: 'Reading one more page…',
  cancelling: 'Cancelling…',
  cancelled: 'Plan cancelled. Nothing ran.',
  askAgain: 'Ask again',
  runAgain: 'Run again',
  tryAgain: 'Try again',
  continue: 'Continue',
  addToGraph: 'Add to graph',
  noAdd: 'This result has nothing to draw on the graph.',
  save: 'Save',
  back: 'Back',
  saving: 'Saving…',
  changed: 'The plan was changed. Nothing has run.',
  nothingToEdit: 'Nothing to change here. Ask the question again to change what it names.',
  cannotEdit: 'This plan cannot be edited here. Ask the question again.',
  heavyTitle: 'This would read more than the source allows without asking.',
  heavyNote: 'Continue reads one page. Cancel keeps the plan from running.',
  mayHaveRun: 'A plan was running when the investigation changed. It may have run; ask again to see a result.',
  maskChanged: 'Masking changed, so this result is cleared. Ask again to see it.',
  added: 'Added to the graph.',
} as const;

/** The template in words; a template the app has no words for is shown by its ID. */
export function templateName(id: string): string {
  switch (id) {
    case 'shared-attribute':
      return 'Shared attribute';
    case 'linked-entities':
      return 'Linked entities';
    case 'entity':
      return 'Entity';
    case 'degree-preview':
      return 'Degree preview';
    case 'expand':
      return 'Expand';
    case 'derived-rule-run':
      return 'Derived rule';
    case 'derived-edge-support':
      return 'Derived relationship support';
    case 'search':
      return 'Search';
    default:
      return id;
  }
}

/** "Ran shared-attribute · 0.31 s · complete": the template, the seconds from the press of Run to the answer, and how it ended. */
export const ranText = (templateId: string, seconds: number, outcome: 'complete' | 'partial'): string => `Ran ${templateId} · ${seconds.toFixed(2)} s · ${outcome}`;
