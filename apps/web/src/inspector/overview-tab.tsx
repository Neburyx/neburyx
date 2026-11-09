import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { canRetry } from '../failure-notice.js';
import { NO_LONGER_IN_SOURCE, RETRY } from '../workspace/expand-copy.js';
import { DETAILS_NOT_READ, NO_KEY_PROPERTIES, QUALITY_LABELS, READING_DETAILS, SOURCE_RECORDS, UNAVAILABLE } from './copy.js';
import type { EntityRead } from './entity-read.js';
import type { InspectorTabProps } from './inspector-tabs.js';
import { NeighborsSection } from './neighbors-section.js';
import { propertyText } from './property-text.js';

function ReadNote({ read }: { readonly read: EntityRead }) {
  if (read.phase === 'loading') return <p role="status">{READING_DETAILS}</p>;
  const failure = read.failure;
  if (failure === undefined) return null;
  if (failure.code === 'NOT_FOUND') return <p role="alert">{NO_LONGER_IN_SOURCE}</p>;
  const retry = 'traceId' in failure && failure.retryable && canRetry(failure);
  return (
    <p role="alert">
      {DETAILS_NOT_READ}
      {retry ? (
        <button type="button" className="neighbor-types-link" onClick={read.reload}>
          {RETRY}
        </button>
      ) : null}
    </p>
  );
}

export function OverviewTab({ node, entity, read }: InspectorTabProps) {
  const profile = useProfileWhenProvided();
  const type = profile?.entityTypes.find((entry) => entry.type === entity.entityType);
  const labels = node.qualityFlags.flatMap((flag) => QUALITY_LABELS.get(flag) ?? []);
  return (
    <div className="inspector-overview">
      <ReadNote read={read} />
      {labels.length === 0 ? null : (
        <ul className="inspector-quality">
          {labels.map(({ label, sentence }) => (
            <li key={label}>
              <strong>{label}</strong>
              {sentence === undefined ? null : <span>{` ${sentence}`}</span>}
            </li>
          ))}
        </ul>
      )}
      {type === undefined ? null : type.keyProperties.length === 0 ? (
        <p>{NO_KEY_PROPERTIES}</p>
      ) : (
        <dl className="inspector-rows">
          {type.keyProperties.map((key) => {
            const property = node.properties.find((candidate) => candidate.key === key);
            return (
              <div key={key} className="inspector-row">
                <dt>{key}</dt>
                <dd>{property === undefined ? UNAVAILABLE : propertyText(property)}</dd>
              </div>
            );
          })}
        </dl>
      )}
      {node.provenanceRefs.length === 0 ? null : (
        <section className="inspector-section" aria-label={SOURCE_RECORDS}>
          <h3 className="inspector-section-title">{SOURCE_RECORDS}</h3>
          <ul className="inspector-records">
            {node.provenanceRefs.map((reference) => (
              <li key={reference}>{reference}</li>
            ))}
          </ul>
        </section>
      )}
      <NeighborsSection entity={entity} />
    </div>
  );
}
