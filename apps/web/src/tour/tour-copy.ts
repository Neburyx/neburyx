export interface TourStep {
  readonly title: string;
  readonly body: string;
}

/** The four steps, as the guided-tour frames draw them. */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Start with an entity',
    body: 'Search an ID, a name or a referral number. Only properties your admin has indexed are searched, and your graph is never changed.',
  },
  {
    title: 'Read the network',
    body: 'Counts say how much is loaded and how much is not retrieved yet. Solid lines come from your graph; dashed lines are derived by a rule.',
  },
  {
    title: 'Right-click for actions',
    body: 'Right-click a node or a relationship to expand, focus, group, copy or open its evidence. Nothing is loaded until you choose it, and counts stay honest.',
  },
  {
    title: 'Keep your work',
    body: 'Save the investigation to resume it later, or export the current view. Exports say they are partial. Nothing is added to your source graph.',
  },
];

export const TOUR_COPY = {
  skip: 'Skip tour',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  waiting: 'The tour continues when you open an investigation.',
  helpItem: 'Take the tour',
} as const;

export function stepLabel(step: number): string {
  return `STEP ${step + 1} OF ${TOUR_STEPS.length}`;
}

export function dialogName(step: number): string {
  return `Guided tour, step ${step + 1} of ${TOUR_STEPS.length}`;
}
