import { act, screen, within } from '@testing-library/react';
import type { DegreePreview, GraphEdge } from '@neburyx/contracts';
import { ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { count, entity, inspectorRig, select, TYPE } from './inspector-kit.js';

export const at = (id: string) => ref('a', TYPE, id);

export function stored(id: string, from: string, to: string, type = 'OWNS'): GraphEdge {
  return { ref: { sourceId: 'a', type, from: TYPE, to: TYPE, stableId: id }, from: at(from), to: at(to), type, direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] };
}

export function derivedEdge(from: string, to: string, type = 'SHARED'): GraphEdge {
  return {
    ref: { sourceId: 'a', derived: { ruleId: 'rule-1', from: at(from), to: at(to) } },
    from: at(from),
    to: at(to),
    type,
    direction: 'from-to',
    semantics: 'derived',
    derivation: { ruleId: 'rule-1', ruleVersion: 1, supportingEdgeRefs: [] },
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  };
}

export function aggregateEdge(from: string, to: string, members: ReturnType<typeof count>, type = 'SENT'): GraphEdge {
  return { ref: { sourceId: 'a', aggregate: { type, from: at(from), to: at(to) } }, memberCount: members, from: at(from), to: at(to), type, direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] };
}

export const unknownOrigin = (id: string, from: string, to: string, type = 'LINKED'): GraphEdge => ({ ...stored(id, from, to, type), semantics: 'unknown' });

export function previewOf(overrides: Partial<DegreePreview> = {}): DegreePreview {
  return {
    ref: at('n1'),
    total: count(22, 'exact'),
    byType: [],
    byNeighborType: [],
    warnings: [],
    pageSize: 25,
    heavyOpThreshold: 1000,
    ...overrides,
  };
}

export const byType = (relationshipType: string, direction: 'out' | 'in', value: ReturnType<typeof count>) => ({ relationshipType, direction, count: value, neighborTypes: [TYPE] });

/** The inspector open on n1 with `others` loaded beside it and the given relationships, on the Relationships tab. */
export async function openRelationships(edges: readonly GraphEdge[], others: readonly string[] = ['n2', 'n3', 'n4']) {
  const rig = inspectorRig({ nodes: [entity('n1'), ...others.map((id) => entity(id))] });
  loadGraph(rig.state, [entity('n1'), ...others.map((id) => entity(id))], edges);
  select(rig.state, 'n1');
  await openTab();
  return rig;
}

export async function openTab(): Promise<void> {
  await act(async () => screen.getByRole('tab', { name: 'Relationships' }).click());
}

export const panel = () => within(screen.getByRole('tabpanel'));
export const rowNames = (): string[] => screen.queryAllByRole('button').filter((button) => button.classList.contains('relationship-row')).map((button) => button.getAttribute('aria-label') ?? '');
export const answerPreview = (rig: ReturnType<typeof inspectorRig>, value: DegreePreview) => act(async () => rig.previews[0]?.answer({ ok: true, value }));
