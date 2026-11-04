import { useEffect } from 'react';
import type { SourceSummary } from '@neburyx/contracts';
import { FailureNotice } from '../failure-notice.js';
import { COPY } from './copy.js';
import { DegreeNotice } from './degree-notice.js';
import { HealthFacts } from './health-facts-view.js';
import { lastTestView } from './health-facts.js';
import { DiagnosticsRow } from './diagnostics-row.js';
import { useExcerpts } from './excerpts-context.js';
import { MappingExample } from './mapping-example.js';
import { StatePill } from './state-pill.js';
import { useStartTest, useTestRun } from './test-runs-context.js';

export function SourceDetail({ source, opening }: { readonly source: SourceSummary; readonly opening: string }) {
  const run = useTestRun(source.id);
  const start = useStartTest();
  const view = lastTestView(source, run.held);
  const excerpts = useExcerpts();
  useEffect(() => excerpts.show(source.id, opening), [excerpts, source.id, opening]);
  return (
    <section className="source-detail" aria-label={COPY.detailLabel(source.alias)}>
      <div className="detail-heading">
        <div className="detail-title">
          <h2>{source.alias}</h2>
          <StatePill state={source.state} />
          <span className="tag">{COPY.readOnly}</span>
        </div>
        <button type="button" className="primary" aria-busy={run.running} aria-disabled={run.running} onClick={() => start(source.id)}>
          {run.running ? <span className="spinner" aria-hidden="true" /> : null}
          {run.running ? COPY.testing : COPY.testSource}
        </button>
      </div>
      <p role="status" className="test-status">
        {run.finishedState === undefined ? '' : COPY.testFinished(run.finishedState)}
      </p>
      {run.failure === undefined ? null : <FailureNotice failure={run.failure} />}
      <HealthFacts source={source} view={view} />
      <DegreeNotice view={view} />
      <MappingExample sourceId={source.id} opening={opening} />
      <DiagnosticsRow />
    </section>
  );
}
