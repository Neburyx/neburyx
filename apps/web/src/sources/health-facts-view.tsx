import type { SourceSummary } from '@neburyx/contracts';
import { COPY } from './copy.js';
import { healthFacts, type Fact, type LastTestView } from './health-facts.js';

export function FactList({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <dl>
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HealthFacts({ source, view }: { readonly source: SourceSummary; readonly view: LastTestView }) {
  return (
    <div className="health-facts">
      <FactList facts={healthFacts(source, view)} />
      <p className="facts-note">{COPY.schemaNote}</p>
    </div>
  );
}
