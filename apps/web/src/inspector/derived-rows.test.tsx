import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DerivedNeighborsResponse, GraphEdge, GraphNode } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { node, ref } from '../state/test-data.js';
import { count, entity, failure, inInspector, inspectorRig, keyOf, select, TYPE } from './inspector-kit.js';

const RULE = { id: 'shared-device', from: TYPE, to: TYPE, via: ['link-a', TYPE, 'link-a'], ruleVersion: 2 };
const OTHER = { id: 'second-rule', from: TYPE, to: 'type-b', via: ['link-b'], ruleVersion: 1 };
const derivedEdge = (from: string, to: string): GraphEdge => ({
  ref: { sourceId: 'a', derived: { ruleId: 'shared-device', from: ref('a', TYPE, from), to: ref('a', TYPE, to) } },
  from: ref('a', TYPE, from),
  to: ref('a', TYPE, to),
  type: 'shared-device',
  direction: 'from-to',
  semantics: 'derived',
  derivation: { ruleId: 'shared-device', ruleVersion: 2, supportingEdgeRefs: [] },
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});
const answerOf = (value: number, quality: 'exact' | 'lowerBound', nodes: GraphNode[] = [], edges: GraphEdge[] = []): DerivedNeighborsResponse => ({
  ref: ref('a', TYPE, 'n1'),
  results: [{ ruleId: 'shared-device', ruleVersion: 2, count: count(value, quality), nodes, edges, warnings: [] }],
});
const rig = () => inspectorRig({ derivedRules: [RULE] });
const answer = (r: ReturnType<typeof inspectorRig>, value: DerivedNeighborsResponse, at = 0) => act(async () => r.derived[at]?.answer({ ok: true, value }));
const sourced = async (r: ReturnType<typeof inspectorRig>) => act(async () => r.previews[0]?.answer({ ok: true, value: (await import('../workspace/supernode-kit.js')).previewOf() }));
const row = () => inInspector().queryByRole('group', { name: /^Linked/ });

describe('the rule-derived row of the Overview', () => {
  it('asks once for the entity when the inspector opens and says it is counting until the answer', () => {
    const r = rig();
    select(r.state, 'n1');
    expect(r.derivedCalls).toEqual([expect.objectContaining({ id: 'n1', mask: false })]);
    expect(inInspector().getByText('Counting rule-derived neighbors…')).toBeTruthy();
  });

  it('shows "Linked <name> · 1 · rule-derived" for an exact count, with the rule in its accessible name', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(1, 'exact'));
    expect(row()?.textContent).toBe('Linked Kind A · 1 · rule-derived');
    expect(row()?.getAttribute('aria-label')).toBe('Linked Kind A · 1 · rule-derived (shared-device)');
  });

  it('shows "≥ 25 · rule-derived · lower bound" for a capped count, and 0 for an exact zero', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(25, 'lowerBound'));
    expect(row()?.textContent).toBe('Linked Kind A · ≥ 25 · rule-derived · lower bound');
    select(r.state, 'n2');
    await answer(r, answerOf(0, 'exact'), 1);
    expect(row()?.textContent).toBe('Linked Kind A · 0 · rule-derived');
  });

  it('draws no row and makes no read for an entity type no rule starts from', () => {
    const r = inspectorRig({ derivedRules: [{ ...RULE, from: 'type-z' }] });
    select(r.state, 'n1');
    expect(r.derivedCalls).toEqual([]);
    expect(row()).toBeNull();
  });

  it('draws one row for each rule that starts from the type, in the order of the profile', async () => {
    const r = inspectorRig({ derivedRules: [RULE, OTHER] });
    select(r.state, 'n1');
    const value = answerOf(2, 'exact');
    await answer(r, { ...value, results: [...value.results, { ...value.results[0], ruleId: 'second-rule', count: count(3, 'exact') } as DerivedNeighborsResponse['results'][number]] });
    expect(inInspector().getAllByRole('group', { name: /^Linked/ }).map((group) => group.textContent)).toEqual(['Linked Kind A · 2 · rule-derived', 'Linked type-b · 3 · rule-derived']);
  });

  it('shows the failure of the run and Retry in the row alone, keeps the rest of the inspector, and asks again on Retry', async () => {
    const r = rig();
    select(r.state, 'n1');
    await sourced(r);
    await act(async () => r.derived[0]?.answer({ ok: false, failure: failure('SOURCE_UNAVAILABLE', true) }));
    expect(inInspector().getByRole('region', { name: 'Sourced neighbors' }).textContent).toContain('trace tr-1');
    expect(inInspector().getByRole('tab', { name: 'Overview' })).toBeTruthy();
    await userEvent.setup().click(inInspector().getAllByRole('button', { name: 'Retry' }).at(-1) as HTMLElement);
    expect(r.derivedCalls).toHaveLength(2);
  });

  it('keeps the row when the sourced preview fails', async () => {
    const r = rig();
    select(r.state, 'n1');
    await act(async () => r.previews[0]?.answer({ ok: false, failure: failure('SOURCE_UNAVAILABLE', true) }));
    await answer(r, answerOf(1, 'exact'));
    expect(row()?.textContent).toBe('Linked Kind A · 1 · rule-derived');
  });

  it('cancels the read when the selection moves to another entity, and shows nothing of a late answer for the first', async () => {
    const r = rig();
    select(r.state, 'n1');
    select(r.state, 'n2');
    expect(r.derivedCalls.map((call) => call.id)).toEqual(['n1', 'n2']);
    expect(r.derivedCalls[0]?.signal?.aborted).toBe(true);
    expect(r.derivedCalls[1]?.signal?.aborted).toBe(false);
    await answer(r, answerOf(7, 'exact'), 0);
    expect(row()?.textContent ?? '').not.toContain('7');
    await answer(r, answerOf(2, 'exact'), 1);
    expect(row()?.textContent).toBe('Linked Kind A · 2 · rule-derived');
  });

  it('asks with the masking flag when the session masks', () => {
    const r = rig();
    act(() => r.state.setMask(true));
    select(r.state, 'n1');
    expect(r.derivedCalls.map((call) => call.mask)).toEqual([true]);
  });
});

describe('Show on the rule-derived row', () => {
  const neighbors = (): { nodes: GraphNode[]; edges: GraphEdge[] } => ({ nodes: [entity('n3'), entity('n4')], edges: [derivedEdge('n1', 'n3'), derivedEdge('n1', 'n4')] });

  it('offers no Show while counting, for a zero count or after a failure', async () => {
    const r = rig();
    select(r.state, 'n1');
    expect(inInspector().queryByRole('button', { name: /^Show/ })).toBeNull();
    await answer(r, answerOf(0, 'exact'));
    expect(inInspector().queryByRole('button', { name: /^Show/ })).toBeNull();
  });

  it('puts the answer into the loaded graph with no second read, leaves the selection and the inspector as they were, and announces how many neighbors were added', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    const reads = r.derivedCalls.length;
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    const loaded = r.state.loadedGraph();
    expect(loaded.nodes.map((entry) => elementKey(entry.ref)).sort()).toEqual([keyOf('n1'), keyOf('n2'), keyOf('n3'), keyOf('n4')].sort());
    expect(loaded.edges.map((edge) => edge.semantics)).toEqual(['derived', 'derived']);
    expect(r.derivedCalls).toHaveLength(reads);
    expect(r.state.presentation.view.getState().moveNote?.text).toBe('2 neighbors added');
    expect(inInspector().getByRole('tab', { name: 'Overview' })).toBeTruthy();
  });

  it('adds nothing a second time and says it is already shown', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    const button = inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' });
    const user = userEvent.setup();
    await user.click(button);
    select(r.state, 'n1');
    await user.click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    expect(r.state.loadedGraph().edges).toHaveLength(2);
    expect(r.state.presentation.view.getState().moveNote?.text).toBe('Already shown');
  });

  it('says "Show 25" for a capped row', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(25, 'lowerBound', neighbors().nodes, neighbors().edges));
    expect(inInspector().getByRole('button', { name: /^Show 25/ }).textContent).toBe('Show 25');
  });

  it('is reached by keyboard and activated by Enter and by Space, and keeps the focus', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    const user = userEvent.setup();
    const button = inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(r.state.loadedGraph().nodes).toHaveLength(4);
    expect(document.activeElement).toBe(button);
    await user.keyboard(' ');
    expect(document.activeElement).toBe(button);
  });

  it('loads the derived relationships but does not draw them while their relationship type is filtered off', async () => {
    const r = rig();
    act(() => r.state.presentation.setMappedTypes({ entityTypes: [TYPE], relationshipTypes: ['shared-device'] }));
    act(() => r.state.setRelationshipTypeOff('shared-device', true));
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    expect(r.state.loadedGraph().edges).toHaveLength(2);
    expect(r.state.visibleGraph().edges).toHaveLength(0);
    expect(r.state.visibleGraph().nodes.map((entry) => entry.ref.stableId).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('does not draw the derived relationship to a hidden entity, and loads the rest', async () => {
    const r = rig();
    loadGraph(r.state, [entity('n1'), entity('n2'), entity('n3')], []);
    act(() => r.state.hide([keyOf('n3')]));
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    const drawn = r.state.visibleGraph();
    expect(drawn.nodes.map((entry) => entry.ref.stableId).sort()).toEqual(['n1', 'n2', 'n4']);
    expect(drawn.edges.map((edge) => edge.to.stableId)).toEqual(['n4']);
    expect(r.state.loadedGraph().edges).toHaveLength(2);
  });

  it('tells a screen reader how many of the loaded entities are outside the neighborhood focus', async () => {
    const r = rig();
    select(r.state, 'n1');
    act(() => r.state.focusOn(keyOf('n1')));
    const stored: GraphEdge = { ...derivedEdge('n3', 'n5'), ref: { sourceId: 'a', type: 'link-a', from: TYPE, to: TYPE, stableId: 's1' }, type: 'link-a', semantics: 'stored' } as GraphEdge;
    const { derivation: _unused, ...support } = stored;
    await answer(r, answerOf(1, 'exact', [entity('n3'), entity('n5')], [derivedEdge('n1', 'n3'), support as GraphEdge]));
    select(r.state, 'n1');
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    expect(r.state.presentation.view.getState().moveNote?.text).toBe('1 of the 2 entities it loaded are outside focus.');
  });

  it('lists the loaded derived relationships in the Relationships tab group', async () => {
    const r = rig();
    select(r.state, 'n1');
    await answer(r, answerOf(2, 'exact', neighbors().nodes, neighbors().edges));
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Show Kind A (shared-device)' }));
    select(r.state, 'n1');
    await userEvent.setup().click(inInspector().getByRole('tab', { name: 'Relationships' }));
    expect(inInspector().getByText('Rule-derived')).toBeTruthy();
    expect(inInspector().getAllByRole('button', { name: /rule-derived/ })).toHaveLength(2);
  });

  it('does not touch the edge keys of relationships already loaded', () => {
    expect(edgeKey(derivedEdge('n1', 'n2').ref)).toContain('shared-device');
    expect(node('a', 'n1').ref.stableId).toBe('n1');
  });
});
