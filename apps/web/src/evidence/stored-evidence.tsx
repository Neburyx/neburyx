import type { EdgeRef, GraphProperty, StoredEdgeDetail } from '@neburyx/contracts';
import { propertyText } from '../inspector/property-text.js';
import { recordLinkHref, SourceRecordLink } from '../workspace/source-link.js';
import { evidenceRecordText } from '../search/copy.js';
import { useEdgeRead, type EdgeRead } from './edge-read.js';
import { EvidenceFailure } from './failure-view.js';
import { ID_LABEL, NOT_AVAILABLE_BADGE, STORED_RELATIONSHIP, NOT_AVAILABLE_TEXT, NOT_AVAILABLE_TITLE, OBSERVED_LABEL, READING_EVIDENCE, reasonSentence, SUPPORTING_RECORDS, WHY_HERE } from './copy.js';
import type { EvidenceKind, EvidenceKindProps } from './evidence-kinds.js';

const isStored = (ref: EdgeRef): ref is Extract<EdgeRef, { stableId: string }> => 'stableId' in ref;

interface StoredRead extends Omit<EdgeRead, 'detail'> {
  readonly detail: StoredEdgeDetail | undefined;
}

function useStoredRead({ edge, mask }: EvidenceKindProps): StoredRead {
  if (!isStored(edge)) throw new Error('the stored evidence is shown for a stored reference only');
  const read = useEdgeRead(edge, mask);
  return { ...read, detail: read.detail?.semantics === 'stored' ? read.detail : undefined };
}

/** The line that names the ends of the relationship in the panel's heading: the titles the read gave, once it has. */
function StoredEndpoints(props: EvidenceKindProps) {
  const { detail } = useStoredRead(props);
  return detail === undefined ? null : <p className="evidence-ends">{`${detail.from.title} → ${detail.to.title}`}</p>;
}

function StoredEvidenceTab(props: EvidenceKindProps) {
  const { detail, failure, reading, reload } = useStoredRead(props);
  if (detail === undefined) {
    if (failure !== undefined) return <EvidenceFailure failure={failure} reading={reading} reload={reload} />;
    return <p role="status">{READING_EVIDENCE}</p>;
  }
  return (
    <section className="evidence-stored" aria-labelledby="evidence-why">
      <p className="evidence-kind">{STORED_RELATIONSHIP}</p>
      <h3 id="evidence-why" className="evidence-why">
        {WHY_HERE}
      </h3>
      <p>{reasonSentence(detail.type, detail.from.title, detail.to.title)}</p>
      {detail.evidence.status === 'available' ? (
        <div className="evidence-records">
          <p>{SUPPORTING_RECORDS}</p>
          <ul>
            {detail.evidence.records.map((record) => (
              <li key={'unreadable' in record ? record.property : record.sourceRecordId}>
                {!('unreadable' in record) && record.linkable ? <SourceRecordLink href={recordLinkHref(detail.ref, record.sourceRecordId, props.mask)}>{record.sourceRecordId}</SourceRecordLink> : evidenceRecordText(record)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="evidence-unavailable">
          <p className="evidence-unavailable-row">
            <span className="evidence-badge">{NOT_AVAILABLE_BADGE}</span>
            <span className="evidence-unavailable-title">{NOT_AVAILABLE_TITLE}</span>
          </p>
          <p className="evidence-unavailable-text">{NOT_AVAILABLE_TEXT}</p>
        </div>
      )}
      {failure === undefined ? null : <EvidenceFailure failure={failure} reading={reading} reload={reload} />}
    </section>
  );
}

const HAS_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})(\[[^\]]*\])?$/;
const NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** A date-time the source gave with an offset is a point in time and is shown in UTC; one with no offset names no instant and is shown as read with its note; anything else (a date, text) is shown as read. */
export function observedProperty(value: string): GraphProperty {
  const dataClass = HAS_OFFSET.test(value) ? 'dateTime' : NO_OFFSET.test(value) ? 'localDateTime' : 'text';
  return { key: OBSERVED_LABEL, value, dataClass, masked: false };
}

function StoredPropertiesTab(props: EvidenceKindProps) {
  const { detail, failure, reading, reload } = useStoredRead(props);
  if (detail === undefined) {
    if (failure !== undefined) return <EvidenceFailure failure={failure} reading={reading} reload={reload} />;
    return <p role="status">{READING_EVIDENCE}</p>;
  }
  const rows = [
    { key: ID_LABEL, text: detail.ref.stableId },
    { key: OBSERVED_LABEL, text: propertyText(detail.observedAt === undefined ? { key: OBSERVED_LABEL, dataClass: 'dateTime', masked: false } : observedProperty(detail.observedAt)) },
    ...detail.properties.map((property) => ({ key: property.key, text: propertyText(property) })),
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
}

export const storedEvidenceKind: EvidenceKind = { id: 'stored', order: 10, matches: isStored, Endpoints: StoredEndpoints, Evidence: StoredEvidenceTab, Properties: StoredPropertiesTab };
