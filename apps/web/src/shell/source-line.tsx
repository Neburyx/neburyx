import type { ApiFailure } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { retainedFailure, useShellData } from './shell-data.js';
import { SourceStatusText } from './source-status-text.js';
import { useCurrentSource } from './use-current-source.js';

function Unreachable({ failure }: { readonly failure: ApiFailure }) {
  if (failure.code === 'NETWORK_UNAVAILABLE') return <p role="alert">Unavailable · {failure.code}</p>;
  return <FailureNotice failure={failure} />;
}

export function SourceLine() {
  const { sources } = useShellData();
  const { current } = useCurrentSource();
  const failure = retainedFailure(sources);

  return (
    <section aria-label="Source">
      {current === undefined ? failure === undefined ? <p role="status">Loading</p> : null : <SourceStatusText current={current} reason={false} />}
      {failure === undefined ? null : <Unreachable failure={failure} />}
    </section>
  );
}
