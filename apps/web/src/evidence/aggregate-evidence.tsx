import type { AggregateEdgeDetail, EdgeRef, GraphProperty } from '@neburyx/contracts';
import { propertyText } from '../inspector/property-text.js';
import { useEdgeRead, type EdgeRead } from './edge-read.js';
import { EvidenceFailure } from './failure-view.js';
import {
  DIRECTED_ARROW,
  AGGREGATE_RELATIONSHIP,
  EMPTY_MEMBER,
  FIRST_OBSERVED_LABEL,
  FROM_LABEL,
  LAST_OBSERVED_LABEL,
  MEMBERS_LABEL,
  MEMBERS_NOT_COUNTED,
  membersScopeLine,
  membersText,
  moreInSampleLine,
  NO_STABLE_ID_SENTENCE,
  READING_EVIDENCE,
  SAMPLE_ORDER_LABEL,
  sampleHeading,
  sampleOrderText,
  TO_LABEL,
  unusableIdSentence,
  WHY_HERE,
} from './copy.js';
import type { EvidenceKind, EvidenceKindProps } from './evidence-kinds.js';
import { observedProperty } from './stored-evidence.js';

const isAggregate = (ref: EdgeRef): ref is Extract<EdgeRef, { aggregate: unknown }> => 'aggregate' in ref;

interface AggregateRead extends Omit<EdgeRead, 'detail'> {
  readonly detail: AggregateEdgeDetail | undefined;
}

function useAggregateRead({ edge, mask }: EvidenceKindProps): AggregateRead {
  if (!isAggregate(edge)) throw new Error('the aggregate evidence is shown for an aggregate reference only');
  const read = useEdgeRead(edge, mask);
  return { ...read, detail: read.detail?.semantics === 'aggregate' ? read.detail : undefined };
}

const observedText = (value: string | undefined): string | undefined => (value === undefined ? undefined : propertyText(observedProperty(value)));
const rowText = (observedAt: string | undefined, properties: readonly GraphProperty[]): string => {
  const text = [observedText(observedAt), ...properties.map((property) => `${property.key} ${propertyText(property)}`)].filter((part) => part !== undefined).join(' · ');
  return text === '' ? EMPTY_MEMBER : text;
};

function AggregateEndpoints(props: EvidenceKindProps) {
  const { detail } = useAggregateRead(props);
  return detail === undefined ? null : <p className="evidence-ends">{`${detail.from.title} ${DIRECTED_ARROW} ${detail.to.title}`}</p>;
}

function Frame({ read, children }: { readonly read: AggregateRead; readonly children: (detail: AggregateEdgeDetail) => React.ReactNode }) {
  const { detail, failure, reading, reload } = read;
  if (detail === undefined) {
    if (failure !== undefined) return <EvidenceFailure failure={failure} reading={reading} reload={reload} />;
    return <p role="status">{READING_EVIDENCE}</p>;
  }
  return (
    <>
      {children(detail)}
      {failure === undefined ? null : <EvidenceFailure failure={failure} reading={reading} reload={reload} />}
    </>
  );
}

const membersLine = (detail: AggregateEdgeDetail): string => (detail.members.value === undefined ? MEMBERS_NOT_COUNTED : membersText(detail.members.value));

function AggregateEvidenceTab(props: EvidenceKindProps) {
  const read = useAggregateRead(props);
  return (
    <Frame read={read}>
      {(detail) => {
        const first = observedText(detail.observedFirst);
        const last = observedText(detail.observedLast);
        return (
          <section className="evidence-aggregate" aria-labelledby="evidence-why">
            <p className="evidence-kind">{AGGREGATE_RELATIONSHIP}</p>
            <h3 id="evidence-why" className="evidence-why">
              {WHY_HERE}
            </h3>
            <p>{detail.qualityFlags.includes('no-stable-id') ? unusableIdSentence(detail.type) : NO_STABLE_ID_SENTENCE}</p>
            <p className="evidence-count">{membersLine(detail)}</p>
            <p className="evidence-scope">{membersScopeLine(detail.type)}</p>
            {detail.members.quality === 'unknown' ? (
              <ul className="evidence-warnings">
                {detail.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {first === undefined ? null : <p>{`${FIRST_OBSERVED_LABEL} ${first}`}</p>}
            {last === undefined ? null : <p>{`${LAST_OBSERVED_LABEL} ${last}`}</p>}
            <p className="evidence-supports-heading">{sampleHeading(detail.sample.order, detail.sample.rows.length)}</p>
            <ul className="evidence-group-supports">
              {detail.sample.rows.map((row, index) => (
                <li key={index}>{rowText(row.observedAt, row.properties)}</li>
              ))}
            </ul>
            {detail.sample.more === undefined || detail.sample.more === 0 ? null : <p className="evidence-more">{moreInSampleLine(detail.sample.more)}</p>}
          </section>
        );
      }}
    </Frame>
  );
}

function AggregatePropertiesTab(props: EvidenceKindProps) {
  const read = useAggregateRead(props);
  return (
    <Frame read={read}>
      {(detail) => {
        const rows = [
          { key: 'Type', text: detail.type },
          { key: FROM_LABEL, text: detail.from.title },
          { key: TO_LABEL, text: detail.to.title },
          { key: MEMBERS_LABEL, text: membersLine(detail) },
          { key: SAMPLE_ORDER_LABEL, text: sampleOrderText(detail.sample.order) },
        ];
        return (
          <dl className="inspector-rows evidence-properties">
            {rows.map((row) => (
              <div key={row.key} className="inspector-row">
                <dt>{row.key}</dt>
                <dd>{row.text}</dd>
              </div>
            ))}
          </dl>
        );
      }}
    </Frame>
  );
}

export const aggregateEvidenceKind: EvidenceKind = { id: 'aggregate', order: 30, matches: isAggregate, Endpoints: AggregateEndpoints, Evidence: AggregateEvidenceTab, Properties: AggregatePropertiesTab };
