import type { ApiFailure } from '../api/client.js';
import { canRetry, failureText } from '../failure-notice.js';
import { ENTITY_NOT_FOUND, ENTITY_NOT_LOADED, GRAPH_UNCHANGED, RETRY, timedOutText, unknownSourceText } from './copy.js';

const traceOf = (failure: ApiFailure): string | undefined => ('traceId' in failure ? failure.traceId : undefined);
const timeoutOf = (failure: ApiFailure): number | undefined => ('details' in failure ? failure.details?.timeoutMs : undefined);

function headlineOf(failure: ApiFailure, sourceId: string): string {
  if (failure.code === 'QUERY_TIMEOUT') return timedOutText(timeoutOf(failure));
  return failure.code === 'NOT_FOUND' ? unknownSourceText(sourceId) : failureText(failure);
}

export function SearchFailure({ failure, sourceId, onRetry }: { readonly failure: ApiFailure; readonly sourceId: string; readonly onRetry: () => void }) {
  const trace = traceOf(failure);
  return (
    <div className="search-failure" role="alert">
      <p>{headlineOf(failure, sourceId)}</p>
      {trace === undefined ? null : <p>trace {trace}</p>}
      <p>{GRAPH_UNCHANGED}</p>
      {canRetry(failure) ? (
        <button type="button" onClick={onRetry}>
          {RETRY}
        </button>
      ) : null}
    </div>
  );
}

export function EntityFailure({ failure }: { readonly failure: ApiFailure }) {
  const trace = traceOf(failure);
  return (
    <div className="search-failure" role="alert">
      <p>{failure.code === 'NOT_FOUND' ? ENTITY_NOT_FOUND : `${ENTITY_NOT_LOADED} ${failure.code}`}</p>
      {trace === undefined ? null : <p>trace {trace}</p>}
    </div>
  );
}
