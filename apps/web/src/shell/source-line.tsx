import type { SourceSummary } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { currentSource } from './current-source.js';
import { answeredData, retainedFailure, useShellData } from './shell-data.js';

function SourceText({ source }: { readonly source: SourceSummary }) {
  return (
    <p>
      <span aria-hidden="true">● </span>
      {source.alias} · read-only · {source.state}
      {source.stateReason === null ? '' : ` · ${source.stateReason}`}
    </p>
  );
}

function Unreachable({ failure }: { readonly failure: ApiFailure }) {
  if (failure.code === 'NETWORK_UNAVAILABLE') return <p role="alert">Unavailable · {failure.code}</p>;
  return <FailureNotice failure={failure} />;
}

export function SourceLine() {
  const { sources } = useShellData();
  const state = useClientState();
  const boundId = useStoreSelector(state.investigation, (current) => current.sourceId);
  const answer = answeredData(sources);
  const failure = retainedFailure(sources);
  const current = answer === undefined ? undefined : currentSource(answer.items, boundId);

  return (
    <section aria-label="Source">
      {current === undefined ? failure === undefined ? <p role="status">Loading</p> : null : null}
      {current?.kind === 'none' ? <p>No source connected</p> : null}
      {current?.kind === 'only' || current?.kind === 'bound' ? <SourceText source={current.source} /> : null}
      {current?.kind === 'bound-unknown' ? (
        <p>
          <span aria-hidden="true">● </span>
          {current.sourceId} · read-only · unknown
        </p>
      ) : null}
      {current?.kind === 'summary' ? (
        <p>
          {current.total} sources · {current.connected} connected
        </p>
      ) : null}
      {failure === undefined ? null : <Unreachable failure={failure} />}
    </section>
  );
}
