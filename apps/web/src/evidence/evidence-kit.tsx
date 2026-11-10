import { act, screen, within } from '@testing-library/react';
import type { AggregateEdgeDetail, DerivedEdgeDetail, EdgeDetail, GraphEdge, StoredEdgeDetail } from '@neburyx/contracts';
import { failure, entity, inspectorRig, keyOf, type Ask, type RigOptions } from '../inspector/inspector-kit.js';
import { aggregateEdge, at, derivedEdge, stored } from '../inspector/relationship-kit.js';
import { TYPE } from '../inspector/inspector-kit.js';
import { edgeKey } from '../state/keys.js';
import { loadGraph } from '../workspace/context-menu-kit.js';

export const DEFAULT_NODES = ['n1', 'n2', 'n3'];

export function detailOf(edge: GraphEdge, overrides: Partial<StoredEdgeDetail> = {}): StoredEdgeDetail {
  if (!('stableId' in edge.ref)) throw new Error('a stored edge is needed');
  return {
    ref: edge.ref,
    type: edge.type,
    semantics: 'stored',
    from: { ref: edge.from, title: `Title ${edge.from.stableId}`, type: TYPE },
    to: { ref: edge.to, title: `Title ${edge.to.stableId}`, type: TYPE },
    properties: [],
    qualityFlags: [],
    evidence: { status: 'available', records: [{ sourceRecordId: `R-${edge.ref.stableId}`, linkable: false }] },
    ...overrides,
  };
}

export const OWNS = stored('e1', 'n1', 'n2', 'OWNS');
export const SENT = stored('e2', 'n1', 'n3', 'SENT');
export const SUMMED = aggregateEdge('n2', 'n3', { value: 3, quality: 'exact', scope: 'x' }, 'PAID');

/** The workspace with the inspector and the relationship evidence bound, a loaded graph with stored and aggregate relationships, and a client whose edge reads wait for the test to answer. */
export function evidenceRig(options: Omit<RigOptions, 'evidence'> = {}, edges: readonly GraphEdge[] = [OWNS, SENT, SUMMED]) {
  const rig = inspectorRig({ ...options, evidence: true, nodes: options.nodes ?? DEFAULT_NODES.map((id) => entity(id)) });
  loadGraph(rig.state, DEFAULT_NODES.map((id) => entity(id)), edges);
  const evidence = rig.evidence;
  if (evidence === undefined) throw new Error('the evidence is not bound');
  return { ...rig, evidence };
}

export const panel = () => screen.queryByRole('complementary', { name: 'Relationship evidence' });
export const inPanel = () => within(screen.getByRole('complementary', { name: 'Relationship evidence' }));
export const selectEdge = (rig: ReturnType<typeof evidenceRig>, edge: GraphEdge): void => void act(() => rig.state.presentation.select([edgeKey(edge.ref)]));
export const answerEdge = (ask: Ask<EdgeDetail> | undefined, value: EdgeDetail) => act(async () => ask?.answer({ ok: true, value }));
export const failEdge = (ask: Ask<EdgeDetail> | undefined, code: string, retryable = false) => act(async () => ask?.answer({ ok: false, failure: failure(code, retryable) }));
export const openOn = (rig: ReturnType<typeof evidenceRig>, edge: GraphEdge): void => void act(() => void rig.evidence.open(edge.ref));
export { at, keyOf };

export const SHARED = derivedEdge('n1', 'n3', 'SHARED');
const end = (id: string) => ({ ref: at(id), title: `Title ${id}`, type: TYPE });
const storedSupport = (id: string, from: string, to: string, records = [{ sourceRecordId: `REC-${id}`, linkable: false }]) => ({
  ref: { sourceId: 'a', type: 'OWNS', from: TYPE, to: TYPE, stableId: id },
  type: 'OWNS',
  from: end(from),
  to: end(to),
  evidence: records.length === 0 ? ({ status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } as const) : ({ status: 'available', records } as const),
});

/** The answer for a derived relationship of the rig: two chains through two middle entities, each with a stored support and one with a support that has no stable ID. */
export function derivedDetailOf(overrides: Partial<DerivedEdgeDetail> = {}): DerivedEdgeDetail {
  const aggregate = {
    ref: { sourceId: 'a', aggregate: { type: 'SENT', from: at('m2'), to: at('n3') } },
    type: 'SENT',
    from: end('m2'),
    to: end('n3'),
    evidence: { status: 'no-stable-id' } as const,
  };
  return {
    ref: { sourceId: 'a', derived: { ruleId: 'rule-1', from: at('n1'), to: at('n3') } },
    type: 'rule-1',
    semantics: 'derived',
    rule: { id: 'rule-1', version: 2 },
    from: end('n1'),
    to: end('n3'),
    supports: {
      count: { value: 2, quality: 'exact', scope: 'derived:supports' },
      groups: [
        { middle: [end('m1')], supports: [storedSupport('s1', 'n1', 'm1', [{ sourceRecordId: 'AUTH-1', linkable: false }, { sourceRecordId: 'AUTH-2', linkable: false }]), storedSupport('s2', 'n3', 'm1', [])] },
        { middle: [end('m2')], supports: [storedSupport('s3', 'n1', 'm2'), aggregate] },
      ],
    },
    qualityFlags: [],
    warnings: [],
    ...overrides,
  };
}

/** The answer for the aggregate of the rig (PAID, n2 to n3): an exact count of 42, three sampled members newest first and the rest as more. */
export function aggregateDetailOf(overrides: Partial<AggregateEdgeDetail> = {}): AggregateEdgeDetail {
  return {
    ref: { sourceId: 'a', aggregate: { type: 'PAID', from: at('n2'), to: at('n3') } },
    type: 'PAID',
    semantics: 'aggregate',
    from: end('n2'),
    to: end('n3'),
    members: { value: 42, quality: 'exact', scope: 'aggregate:members' },
    observedFirst: '2026-01-01T10:00:00Z',
    observedLast: '2026-01-28T10:00:00Z',
    sample: {
      order: 'observed-newest',
      rows: [28, 27, 26].map((day) => ({ observedAt: `2026-01-${day}T10:00:00Z`, properties: [{ key: 'remark', value: 'web', dataClass: 'text' as const, masked: false }] })),
      more: 39,
    },
    qualityFlags: [],
    warnings: [],
    ...overrides,
  };
}
