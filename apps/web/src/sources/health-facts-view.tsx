import type { SourceSummary } from '@neburyx/contracts';
import { COPY } from './copy.js';
import { healthFacts, type LastTestView } from './health-facts.js';

export function HealthFacts({ source, view }: { readonly source: SourceSummary; readonly view: LastTestView }) {
  return (
    <div className="health-facts">
      <dl>
        {healthFacts(source, view).map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <p className="facts-note">{COPY.schemaNote}</p>
    </div>
  );
}
