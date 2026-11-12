import type { DerivedEdgeDetail, DerivedSupport, EdgeEnd, EdgeRef } from '@neburyx/contracts';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { evidenceRecordText } from '../search/copy.js';
import { useEdgeRead, type EdgeRead } from './edge-read.js';
import { EvidenceFailure } from './failure-view.js';
import {
  arrowOf,
  aggregateEvidenceLabel,
  derivationSentence,
  DERIVED_RELATIONSHIP,
  FROM_LABEL,
  groupsCountText,
  NO_CONFIDENCE_SCORE,
  NO_STABLE_ID_TEXT,
  NOT_AVAILABLE_BADGE,
  NOT_AVAILABLE_ROW,
  OPEN_AGGREGATE_EVIDENCE,
  READING_EVIDENCE,
  RULE_LABEL,
  RULE_VERSION_LABEL,
  SUPPORTING_RELATIONSHIPS,
  SUPPORTS_LABEL,
  TO_LABEL,
  WHY_HERE,
} from './copy.js';
import type { EvidenceKind, EvidenceKindProps } from './evidence-kinds.js';

const isDerived = (ref: EdgeRef): ref is Extract<EdgeRef, { derived: unknown }> => 'derived' in ref;

interface DerivedRead extends Omit<EdgeRead, 'detail'> {
  readonly detail: DerivedEdgeDetail | undefined;
}

function useDerivedRead({ edge, mask }: EvidenceKindProps): DerivedRead {
  if (!isDerived(edge)) throw new Error('the derived evidence is shown for a derived reference only');
  const read = useEdgeRead(edge, mask);
  return { ...read, detail: read.detail?.semantics === 'derived' ? read.detail : undefined };
}

function DerivedEndpoints(props: EvidenceKindProps) {
  const { detail } = useDerivedRead(props);
  const profile = useProfileWhenProvided();
  return detail === undefined ? null : <p className="evidence-ends">{`${detail.from.title} ${arrowOf(props.edge, profile)} ${detail.to.title}`}</p>;
}

/** The display name of an end's entity type from the source profile when the page has one, else the name the answer gave. */
function useTypeNames(): (end: EdgeEnd) => string {
  const profile = useProfileWhenProvided();
  return (end) => profile?.entityTypes.find((entry) => entry.type === end.ref.entityType)?.displayName ?? end.type;
}

function SupportEvidence({ support, open }: { readonly support: DerivedSupport; readonly open: EvidenceKindProps['open'] }) {
  const { evidence } = support;
  if (evidence.status === 'available') return <span className="evidence-support-records">{evidence.records.map(evidenceRecordText).join(', ')}</span>;
  if (evidence.status === 'no-stable-id') {
    return (
      <span className="evidence-support-note">
        {NO_STABLE_ID_TEXT}
        {open === undefined ? null : (
          <>
            {' '}
            <button type="button" className="neighbor-types-link" aria-label={aggregateEvidenceLabel(support.type, support.from.title, support.to.title)} onClick={() => open(support.ref)}>
              {OPEN_AGGREGATE_EVIDENCE}
            </button>
          </>
        )}
      </span>
    );
  }
  return (
    <span className="evidence-support-note">
      <span className="evidence-badge">{NOT_AVAILABLE_BADGE}</span> {NOT_AVAILABLE_ROW}
    </span>
  );
}

function Frame({ read, children }: { readonly read: DerivedRead; readonly children: (detail: DerivedEdgeDetail) => React.ReactNode }) {
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

function DerivedEvidenceTab(props: EvidenceKindProps) {
  const read = useDerivedRead(props);
  const typeName = useTypeNames();
  const endText = (end: EdgeEnd): string => `${end.title} · ${typeName(end)}`;
  return (
    <Frame read={read}>
      {(detail) => {
        const middleTypes = (detail.supports.groups[0]?.middle ?? []).map(typeName);
        const count = detail.supports.count;
        return (
          <section className="evidence-derived" aria-labelledby="evidence-why">
            <p className="evidence-kind">{DERIVED_RELATIONSHIP}</p>
            <h3 id="evidence-why" className="evidence-why">
              {WHY_HERE}
            </h3>
            <p>{derivationSentence(detail.rule.id, detail.rule.version, detail.from.title, detail.to.title, middleTypes)}</p>
            <p className="evidence-supports-heading">
              {SUPPORTING_RELATIONSHIPS} <span className="evidence-count">{groupsCountText(count.value ?? 0, count.quality === 'exact' ? 'exact' : 'lowerBound')}</span>
            </p>
            <ul className="evidence-groups">
              {detail.supports.groups.map((group) => (
                <li key={JSON.stringify(group.middle.map((end) => end.ref))} className="evidence-group">
                  <p className="evidence-group-title">{group.middle.map(endText).join(' → ')}</p>
                  <ul className="evidence-group-supports">
                    {group.supports.map((support) => (
                      <li key={JSON.stringify(support.ref)}>
                        <span className="evidence-support-edge">{`${support.type}: ${support.from.title} → ${support.to.title}`}</span> <SupportEvidence support={support} open={props.open} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="evidence-no-score">{NO_CONFIDENCE_SCORE}</p>
          </section>
        );
      }}
    </Frame>
  );
}

function DerivedPropertiesTab(props: EvidenceKindProps) {
  const read = useDerivedRead(props);
  const typeName = useTypeNames();
  const endText = (end: EdgeEnd): string => `${end.title} · ${typeName(end)}`;
  return (
    <Frame read={read}>
      {(detail) => {
        const count = detail.supports.count;
        const rows = [
          { key: RULE_LABEL, text: detail.rule.id },
          { key: RULE_VERSION_LABEL, text: String(detail.rule.version) },
          { key: FROM_LABEL, text: endText(detail.from) },
          { key: TO_LABEL, text: endText(detail.to) },
          { key: SUPPORTS_LABEL, text: groupsCountText(count.value ?? 0, count.quality === 'exact' ? 'exact' : 'lowerBound') },
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

export const derivedEvidenceKind: EvidenceKind = { id: 'derived', order: 20, matches: isDerived, Endpoints: DerivedEndpoints, Evidence: DerivedEvidenceTab, Properties: DerivedPropertiesTab };
