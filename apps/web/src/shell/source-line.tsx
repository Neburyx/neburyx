import { FailureBox } from '../failure-box.js';
import { RETRY_NAMES } from '../failure-copy.js';
import { retainedFailure, useShellData } from './shell-data.js';
import { SourceStatusText } from './source-status-text.js';
import { useCurrentSource } from './use-current-source.js';

const UNAVAILABLE = 'Unavailable · ';

export function SourceLine() {
  const { sources, reloadSources } = useShellData();
  const { current } = useCurrentSource();
  const failure = retainedFailure(sources);

  return (
    <section aria-label="Source">
      {current === undefined ? failure === undefined ? <p role="status">Loading</p> : null : <SourceStatusText current={current} reason={false} />}
      {failure === undefined ? null : <FailureBox failure={failure} {...(failure.code === 'NETWORK_UNAVAILABLE' ? { prefix: UNAVAILABLE } : {})} retry={{ name: RETRY_NAMES.sources, run: reloadSources }} />}
    </section>
  );
}
