import { act, render, screen, within } from '@testing-library/react';
import type { GraphEdge, GraphNode, SourceProfile } from '@neburyx/contracts';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey } from '../state/keys.js';
import { entity, inspectorRig, keyOf, profileOf, property, select, TYPE } from '../inspector/inspector-kit.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { SelectionActionsProvider } from '../workspace/selection-actions.js';
import { SelectionBar } from '../workspace/selection-bar.js';

export { entity, keyOf, property, select, TYPE };

/** The profile of the rig with the mapped property lists of its entity type and of the given relationship types. */
export interface RelationshipRow {
  readonly type: string;
  readonly from?: string;
  readonly to?: string;
  readonly properties: readonly string[];
  readonly observedAt?: string;
  readonly stableIdProperty?: string;
}

export function profileWith(properties: readonly string[], relationships: Readonly<Record<string, readonly string[]>> | readonly RelationshipRow[] = {}): SourceProfile {
  const rows: readonly RelationshipRow[] = Array.isArray(relationships) ? relationships : Object.entries(relationships).map(([type, list]) => ({ type, properties: list }));
  const base = profileOf();
  return {
    ...base,
    entityTypes: base.entityTypes.map((entry) => ({ ...entry, properties: [...properties] })),
    relationshipTypes: rows.map((row) => ({ type: row.type, from: row.from ?? TYPE, to: row.to ?? TYPE, aggregate: false, observedAt: row.observedAt ?? null, stableIdProperty: row.stableIdProperty ?? null, filterable: [], sortable: [], evidence: [], properties: [...row.properties] })),
  };
}

export interface CompareRigOptions {
  readonly nodes?: readonly GraphNode[];
  readonly edges?: readonly GraphEdge[];
  readonly profile?: SourceProfile;
  readonly evidence?: boolean;
}

/** The workspace with the comparison bound, the selection bar drawn beside it, a loaded graph, and a client whose reads wait: any that is made is a failure of the test. */
export function compareRig(options: CompareRigOptions = {}) {
  const nodes = options.nodes ?? ['n1', 'n2', 'n3'].map((id) => entity(id, [property('holder', `Holder ${id}`)]));
  const rig = inspectorRig({ compare: true, evidence: options.evidence === true, nodes, profile: options.profile ?? profileWith(['holder']) });
  loadGraph(rig.state, nodes, options.edges ?? []);
  render(
    <ClientStateProvider state={rig.state}>
      <SelectionActionsProvider registry={rig.actions}>
        <SelectionBar />
      </SelectionActionsProvider>
    </ClientStateProvider>,
  );
  const reads = (): number => rig.entityCalls.length + rig.edgeCalls.length + rig.previews.length + rig.derivedCalls.length;
  return { ...rig, reads, compare: rig.compare ?? (() => { throw new Error('the comparison is not bound'); })() };
}

export type CompareRig = ReturnType<typeof compareRig>;

export const dock = (): HTMLElement | null => screen.queryByRole('complementary', { name: 'Compare' });
export const inDock = () => within(screen.getByRole('complementary', { name: 'Compare' }));
export const bar = () => screen.getByRole('toolbar', { name: 'Selection actions' });
export const chooseCompare = async (): Promise<void> => void (await act(async () => within(bar()).getByRole('button', { name: /^Compare/ }).click()));
export const selectEdges = (rig: CompareRig, ...edges: GraphEdge[]): void => void act(() => rig.state.presentation.select(edges.map((edge) => edgeKey(edge.ref))));

/** The column titles of the table. */
export const columns = (): string[] => inDock().getAllByRole('columnheader').slice(1).map((cell) => cell.querySelector('.compare-column-title')?.textContent ?? '');

/** Each row as its label, then its status word, then the text of its cells. */
export const rows = (): string[][] =>
  inDock()
    .getAllByRole('row')
    .slice(1)
    .map((row) => [row.querySelector('.compare-row-label')?.textContent ?? '', row.getAttribute('data-status') ?? '', ...[...row.querySelectorAll('td')].map((cell) => cell.querySelector('.compare-cell-text')?.textContent ?? '')]);

export const kindsOf = (label: string): string[] => {
  const row = inDock().getAllByRole('row').find((candidate) => candidate.querySelector('.compare-row-label')?.textContent === label);
  return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.getAttribute('data-kind') ?? '');
};
