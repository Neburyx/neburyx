import { Link } from 'react-router';
import type { SourceSummary } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { SOURCES_PATH } from '../shell/navigation.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { COPY } from '../sources/copy.js';
import { FactList } from '../sources/health-facts-view.js';
import { healthFacts, lastTestView } from '../sources/health-facts.js';
import { StatePill } from '../sources/state-pill.js';
import { useTestRun } from '../sources/test-runs-context.js';
import { HEALTH_COPY } from './copy.js';

function SourceBlock({ source }: { readonly source: SourceSummary }) {
  const view = lastTestView(source, useTestRun(source.id).held);
  const facts = healthFacts(source, view).filter((fact) => fact.label !== COPY.labels.connection);
  return (
    <li className="source-health-block">
      <div className="source-health-title">
        <h3>{source.alias}</h3>
        <StatePill state={source.state} />
        {source.stateReason === null ? null : <span className="source-reason">{source.stateReason}</span>}
      </div>
      <div className="health-facts">
        <FactList facts={facts} />
      </div>
    </li>
  );
}

function Failure({ failure, retry, headline }: { readonly failure: ApiFailure; readonly retry: () => void; readonly headline: boolean }) {
  return (
    <div className="source-health-failure">
      {headline ? <p>{COPY.couldNotRead}</p> : null}
      <FailureNotice failure={failure} />
      {canRetry(failure) ? (
        <button type="button" className="secondary" onClick={retry}>
          {COPY.tryAgain}
        </button>
      ) : null}
    </div>
  );
}

export function SourceHealthCard() {
  const { sources: state, reloadSources } = useShellData();
  const items = answeredData(state)?.items;
  const failure = retainedFailure(state);
  return (
    <section className="source-health" aria-labelledby="source-health-title">
      <h2 id="source-health-title">{HEALTH_COPY.title}</h2>
      {items === undefined ? (
        failure === undefined ? (
          <p role="status">{COPY.loadingSources}</p>
        ) : (
          <Failure failure={failure} retry={reloadSources} headline />
        )
      ) : (
        <>
          {failure === undefined ? null : <Failure failure={failure} retry={reloadSources} headline={false} />}
          {items.length === 0 ? (
            <p>{COPY.noSources}</p>
          ) : (
            <ul className="source-health-blocks">
              {items.map((source) => (
                <SourceBlock key={source.id} source={source} />
              ))}
            </ul>
          )}
          <Link to={SOURCES_PATH}>{HEALTH_COPY.viewSources}</Link>
        </>
      )}
    </section>
  );
}
