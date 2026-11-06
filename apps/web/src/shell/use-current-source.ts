import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { currentSource, showsSyntheticBadge, sourceNameOf, type CurrentSource } from './current-source.js';
import { answeredData, useShellData } from './shell-data.js';

export interface CurrentSourceView {
  /** Undefined until the sources have been read once. */
  readonly current: CurrentSource | undefined;
  readonly showsSyntheticBadge: boolean;
}

export function useCurrentSource(): CurrentSourceView {
  const answer = answeredData(useShellData().sources);
  const boundId = useStoreSelector(useClientState().investigation, (state) => state.sourceId);
  if (answer === undefined) return { current: undefined, showsSyntheticBadge: false };
  const current = currentSource(answer.items, boundId);
  return { current, showsSyntheticBadge: showsSyntheticBadge(current, answer.items) };
}

export function useSourceName(sourceId: string): string {
  const answer = answeredData(useShellData().sources);
  return answer === undefined ? sourceId : sourceNameOf(answer.items, sourceId);
}
