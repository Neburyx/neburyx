import type { InvestigationListResponse, SourcesResponse } from '@neburyx/contracts';
import type { RequestState } from '../api/use-request.js';
import { answeredData } from '../shell/shell-data.js';

export type StartPage = 'first-run' | 'home';

export interface StartReads {
  readonly sources: RequestState<SourcesResponse>;
  readonly list: RequestState<InvestigationListResponse>;
  /** Whether this visit has asked for the list yet; before that, what the store holds is from an earlier visit. */
  readonly asked: boolean;
  /** The count of the newest list read of this visit that succeeded, kept until the next one succeeds. */
  readonly settledCount: number | undefined;
}

const CONNECTED_STATES: readonly string[] = ['connected', 'degraded'];

function hasConnectedRealSource(sources: SourcesResponse): boolean {
  return sources.items.some((source) => !source.synthetic && CONNECTED_STATES.includes(source.state));
}

function latestAttemptFailed<T>(state: RequestState<T>): boolean {
  return state.phase === 'failed' || (state.phase === 'ready' && state.failure !== undefined);
}

/**
 * The page the start address shows, or `pending` while the reads that decide it have not answered. The rows are tried in order and the first
 * that fits decides; a page already shown is kept by the caller until a decision other than `pending` replaces it.
 */
export function decideStart({ sources, list, asked, settledCount }: StartReads): StartPage | 'pending' {
  const heldSources = answeredData(sources);
  if (settledCount !== undefined) {
    if (settledCount >= 1) return 'home';
    if (heldSources !== undefined) return hasConnectedRealSource(heldSources) ? 'home' : 'first-run';
    return sources.phase === 'failed' ? 'home' : 'pending';
  }
  const heldCount = answeredData(list)?.counts.investigations.value;
  if (heldCount !== undefined && heldCount >= 1) return 'home';
  if (sources.phase === 'failed' || (asked && latestAttemptFailed(list))) return 'home';
  return 'pending';
}
