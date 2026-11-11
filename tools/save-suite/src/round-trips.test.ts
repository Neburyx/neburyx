import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DRAFT_DOCUMENT_BYTES, MAX_REFERENCE_VALUE_CHARACTERS } from '@neburyx/contracts';
import { decodeStored } from '../../../services/api/src/reference/stored-text.js';
import { AUTOSAVE_DELAY_MS, ref, SOURCE, startSuite, World, type Suite, type Tab } from './rig.js';
import { LINKED, ODD_IDS } from './scenarios.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});


async function saveAndReopen(running: Suite, leaves: readonly string[], edges: readonly string[]): Promise<{ readonly before: Tab; readonly after: Tab; readonly id: string }> {
  const before = running.tab();
  await before.open(ref('hub', 'H-1'));
  const id = before.state.investigation.getState().id ?? '';
  await before.load(leaves.map((leaf) => ref('leaf', leaf)), edges.map(LINKED));
  before.state.presentation.setPositions(new Map(leaves.map((leaf, at) => [before.nodeKey('leaf', leaf), { x: at, y: -at }] as const)));
  await running.advance(AUTOSAVE_DELAY_MS);
  await before.written();
  const after = running.tab();
  expect(await after.openById(id)).toMatchObject({ kind: 'shown', id });
  return { before, after, id };
}

describe('identifiers a database or a path cannot hold as they are', () => {
  it('come back with their own ids, with a stored relationship to each, and no response is a server error', async () => {
    const world = new World().entity('hub', 'H-1');
    ODD_IDS.forEach((leaf, at) => world.entity('leaf', leaf).relationship('LINKED', ['hub', 'H-1'], ['leaf', leaf], `r-${at}`));
    suite = await startSuite({ world });
    const { before, after } = await saveAndReopen(suite, ODD_IDS, ODD_IDS.map((_leaf, at) => `r-${at}`));
    expect(after.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', ...ODD_IDS].sort());
    expect(after.state.loadedGraph().edges.map((edge) => 'stableId' in edge.ref ? edge.ref.stableId : '').sort()).toEqual(ODD_IDS.map((_leaf, at) => `r-${at}`).sort());
    expect(after.canonical()).toBe(before.canonical());
    const stored = suite.draft()?.layout.nodes.map((node) => node.id) ?? [];
    expect(stored.some((id) => id.includes('\u0000'))).toBe(false);
    expect(stored.map(decodeStored).sort()).toEqual(['H-1', ...ODD_IDS].sort());
    for (const tab of [before, after]) expect(tab.bodies.filter((body) => body.includes('"INTERNAL_ERROR"'))).toEqual([]);
  });

  it('are refused, and nothing is stored, when one entry is larger than the request size limit', async () => {
    suite = await startSuite();
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    const id = tab.state.investigation.getState().id ?? '';
    const stored = structuredClone(suite.draft());
    const tooLong = 'y'.repeat(MAX_DRAFT_DOCUMENT_BYTES);
    const base = stored?.layout.nodes[0] as { t: string; id: string; pinned: boolean; hidden: boolean; groupId: null };
    const layout = { ...stored?.layout, nodes: [base, { ...base, t: 'leaf', id: tooLong }] };
    const queryContext = { ...stored?.queryContext, loaded: { nodes: [{ t: 'hub', id: 'H-1' }, { t: 'leaf', id: tooLong }], edges: [] } };
    const refused = await tab.client.saveDraft(id, stored?.version ?? 1, { notes: null, layout, queryContext } as Parameters<Tab['client']['saveDraft']>[2]);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? '' : refused.failure.code).toBe('INVALID_REQUEST');
    expect(suite.draft()).toEqual(stored);
  });
});

describe('an identifier of the largest length the contract takes', () => {
  it('is saved and reopened when the investigation holds it alone, and a document past the size limit is refused and stores nothing', async () => {
    const longId = 'z'.repeat(MAX_REFERENCE_VALUE_CHARACTERS);
    const world = new World().entity('hub', longId);
    suite = await startSuite({ world });
    const before = suite.tab();
    expect(await before.open(ref('hub', longId))).toMatchObject({ kind: 'shown' });
    const id = before.state.investigation.getState().id ?? '';
    before.state.presentation.setPositions(new Map([[before.nodeKey('hub', longId), { x: 3, y: 4 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await before.written();
    const after = suite.tab();
    expect(await after.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(after.state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual([longId]);
    expect(after.state.presentation.view.getState().positions.get(after.nodeKey('hub', longId))).toEqual({ x: 3, y: 4 });

    const stored = structuredClone(suite.draft());
    const entry = stored?.layout.nodes[0] as { t: string; id: string; pinned: boolean; hidden: boolean; groupId: null };
    const copies = Math.ceil(MAX_DRAFT_DOCUMENT_BYTES / MAX_REFERENCE_VALUE_CHARACTERS) + 1;
    const nodes = Array.from({ length: copies }, (_unused, at) => ({ ...entry, id: `${at}${longId.slice(1)}` }));
    const refused = await after.client.saveDraft(id, stored?.version ?? 1, { notes: null, layout: { ...stored?.layout, nodes }, queryContext: { ...stored?.queryContext, loaded: { nodes: nodes.map(({ t, id: nodeId }) => ({ t, id: nodeId })), edges: [] } } } as Parameters<Tab['client']['saveDraft']>[2]);
    expect(refused.ok).toBe(false);
    expect(suite.draft()).toEqual(stored);
  });
});

describe('two entity types that share an identifier', () => {
  it('keep their stored relationship apart: the reopened relationship joins the same two entities', async () => {
    const world = new World().entity('hub', 'X-1').entity('leaf', 'X-1').entity('part', 'X-1');
    world.relationship('LINKED', ['hub', 'X-1'], ['leaf', 'X-1'], 'r-leaf').relationship('HAS', ['hub', 'X-1'], ['part', 'X-1'], 'r-part');
    suite = await startSuite({ world });
    const before = suite.tab();
    await before.open(ref('hub', 'X-1'));
    const id = before.state.investigation.getState().id ?? '';
    await before.load([ref('leaf', 'X-1'), ref('part', 'X-1')], [LINKED('r-leaf'), { sourceId: SOURCE, type: 'HAS', from: 'hub', to: 'part', stableId: 'r-part' }]);
    before.state.presentation.setPositions(new Map([[before.nodeKey('leaf', 'X-1'), { x: 1, y: 1 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await before.written();
    const after = suite.tab();
    await after.openById(id);
    const ends = after.state.loadedGraph().edges.map((edge) => [edge.type, edge.from.entityType, edge.from.stableId, edge.to.entityType, edge.to.stableId]).sort();
    expect(ends).toEqual([['HAS', 'hub', 'X-1', 'part', 'X-1'], ['LINKED', 'hub', 'X-1', 'leaf', 'X-1']]);
    expect(after.state.loadedGraph().nodes).toHaveLength(3);
    expect(suite.draft()?.queryContext.loaded.edges.map((edge) => [edge.t, edge.from.t, edge.to.t]).sort()).toEqual([['HAS', 'hub', 'part'], ['LINKED', 'hub', 'leaf']]);
  });
});

describe('a stored relationship entry the contract does not take', () => {
  it('is refused with INVALID_REQUEST and nothing is stored when an end is missing; one that names an unmapped type is stored as sent', async () => {
    suite = await startSuite();
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    const id = tab.state.investigation.getState().id ?? '';
    const stored = structuredClone(suite.draft());
    const body = (edge: Record<string, unknown>) => ({ notes: null, layout: stored?.layout, queryContext: { ...stored?.queryContext, loaded: { nodes: stored?.queryContext.loaded.nodes, edges: [edge] } } }) as unknown as Parameters<Tab['client']['saveDraft']>[2];
    const noEnd = await tab.client.saveDraft(id, stored?.version ?? 1, body({ t: 'LINKED', from: { t: 'hub', id: 'H-1' }, id: 'r-1' }));
    expect(noEnd.ok ? '' : noEnd.failure.code).toBe('INVALID_REQUEST');
    expect(suite.draft()).toEqual(stored);
    const unmapped = await tab.client.saveDraft(id, stored?.version ?? 1, body({ t: 'RETIRED', from: { t: 'hub', id: 'H-1' }, to: { t: 'gone', id: 'GONE-1' }, id: 'r-2' }));
    expect(unmapped).toMatchObject({ ok: true });
    expect(suite.draft()?.queryContext.loaded.edges).toEqual([{ t: 'RETIRED', from: { t: 'hub', id: 'H-1' }, to: { t: 'gone', id: 'GONE-1' }, id: 'r-2' }]);
  });
});
