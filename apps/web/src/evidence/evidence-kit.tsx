import { act, screen, within } from '@testing-library/react';
import type { EdgeDetail, GraphEdge } from '@neburyx/contracts';
import { failure, entity, inspectorRig, keyOf, type Ask, type RigOptions } from '../inspector/inspector-kit.js';
import { aggregateEdge, at, stored } from '../inspector/relationship-kit.js';
import { TYPE } from '../inspector/inspector-kit.js';
import { edgeKey } from '../state/keys.js';
import { loadGraph } from '../workspace/context-menu-kit.js';

export const DEFAULT_NODES = ['n1', 'n2', 'n3'];

export function detailOf(edge: GraphEdge, overrides: Partial<EdgeDetail> = {}): EdgeDetail {
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
