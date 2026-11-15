import type { PathsRequest } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';

export const PATHS_COPY = {
  searchLabel: 'Search the source',
  searchFailed: 'The search could not be completed.',
  searchNone: 'Nothing found.',
  toolLabel: 'Paths',
  title: 'Bounded path search',
  close: 'Close Paths',
  from: 'From',
  to: 'To',
  choose: 'Choose an entity',
  maxHops: 'Max hops',
  direction: 'Direction',
  limit: 'Result cap',
  relationships: 'Allowed relationships',
  find: 'Find paths',
  cancel: 'Cancel',
  results: 'Paths found',
  steps: 'Steps',
} as const;

export const DIRECTION_LABELS: Readonly<Record<NonNullable<PathsRequest['direction']>, string>> = { both: 'Either', out: 'Out', in: 'In' };

export type FormProblem = 'no-from' | 'no-to' | 'same' | 'no-types';

/** The reason **Find paths** is not offered. The frames give no text for these. */
export const PROBLEM_TEXT: Readonly<Record<FormProblem, string>> = {
  'no-from': 'Choose where the paths start.',
  'no-to': 'Choose where the paths end.',
  same: 'Choose two different entities.',
  'no-types': 'Choose at least one relationship type.',
};

export const timeoutLabel = (timeoutMs: number): string => `${Math.round(timeoutMs / 100) / 10} s timeout`;

const seconds = (elapsedMs: number): string => (elapsedMs / 1000).toFixed(2);

/** "2 paths · 0.42 s · cap not reached" (ui-spec 9.4); a partial answer makes no claim about the cap. The wording of a partial answer is not in the frames. */
export const summaryText = (paths: number, elapsedMs: number, capReached: boolean, partial = false): string => `${paths} ${paths === 1 ? 'path' : 'paths'} · ${seconds(elapsedMs)} s · ${partial ? 'partial' : capReached ? 'cap reached' : 'cap not reached'}`;

/** Frame 15, Partial: "5 s timeout · 2 of 5 requested paths retained". */
export const partialReason = (timeoutMs: number | undefined): string | undefined => (timeoutMs === undefined ? undefined : `${Math.round(timeoutMs / 100) / 10} s timeout`);
export const reviewLabel = (retained: number): string => `Review ${retained} ${retained === 1 ? 'path' : 'paths'}`;

export const pathTitle = (position: number, hops: number): string => `Path ${position} · ${hops} ${hops === 1 ? 'hop' : 'hops'}`;

/** Shown when no path was found; the frames give no text for it. */
export const noPathText = (maxHops: number): string => `No path found within ${maxHops} ${maxHops === 1 ? 'hop' : 'hops'}.`;

export const SELECTED_LABEL = 'Selected';
export const evidenceLabel = (reference: string): string => `Evidence · ${reference} ↗`;
export const EVIDENCE_NONE = 'Evidence not available';

/** The entities of a chosen path that stay hidden by a filter; the frames give no text for it. */
export const hiddenByFiltersText = (count: number): string => `${count} ${count === 1 ? 'entity of this path is' : 'entities of this path are'} hidden by filters.`;

/** Shown for a failure the app's banner did not show; no text in the frames. */
export const FAILED_TEXT = 'The search could not be completed.';

const numberDetail = (failure: ApiFailure, name: string): number | undefined => {
  if (!('details' in failure) || typeof failure.details !== 'object' || failure.details === null || !(name in failure.details)) return undefined;
  const value: unknown = Reflect.get(failure.details, name);
  return typeof value === 'number' ? value : undefined;
};

/** What the panel says of a failure: for the server's refusal of a request above the source's limit, the limit it names; the frames give no text for it. */
export function failureText(failure: ApiFailure): string {
  if (failure.code !== 'QUERY_BUDGET_EXCEEDED') return FAILED_TEXT;
  const hops = numberDetail(failure, 'maxHops');
  const results = numberDetail(failure, 'pathResultsCap') ?? numberDetail(failure, 'maxPage');
  if (hops !== undefined) return `This is above the source's limit: at most ${hops} ${hops === 1 ? 'hop' : 'hops'}.`;
  if (results !== undefined) return `This is above the source's limit: at most ${results} ${results === 1 ? 'path' : 'paths'}.`;
  return "This is above the source's limit.";
}
export const RETRY_LABEL = 'Retry';
export const NO_SOURCE_TEXT = 'Open an investigation to find paths.';

export const PATHS_ACTIONS = {
  between: 'Paths between',
  fromHere: 'Find paths from here…',
  toHere: 'Find paths to…',
  betweenEndpoints: 'Find paths between endpoints',
  keyLabel: 'Find paths',
  /** Shown beside Paths between when the selection holds no two entities; no text in the frames. */
  needTwo: 'Select two entities.',
} as const;
