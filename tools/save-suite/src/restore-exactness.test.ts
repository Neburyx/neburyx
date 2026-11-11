import { afterEach, describe, expect, it } from 'vitest';
import { MAX_READ_REFS } from '@neburyx/contracts';
import { restoreNamedView } from '../../../apps/web/src/views/restore-view.js';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../../../services/api/src/gate/templates/aggregate-evidence.js';
import { DERIVED_EDGE_SUPPORT_ID } from '../../../services/api/src/gate/templates/derived-edge-support.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { account, chain, DERIVED_AGGREGATE, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, device, uses } from '../../../services/api/src/testing/derived-fixtures.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { AUTOSAVE_DELAY_MS, idsRead, ref, SOURCE, startSuite, World, type Suite, type Tab } from './rig.js';
import { arranged, reopen } from './scenarios.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const draftWrites = (tab: Tab) => tab.draftWrites();

describe('a saved investigation reopened in a fresh client', () => {
  it('restores the visible and hidden items, positions, pins, filters, layout and viewport exactly, and writes nothing on the way back', async () => {
    suite = await startSuite();
    const { tab, id } = await arranged(suite);
    const before = suite.draft();
    const reopened = await reopen(suite, id);
    expect(reopened.canonical()).toBe(tab.canonical());
    expect(JSON.parse(reopened.canonical())).toMatchObject({ layout: 'radial', viewport: { zoom: 1.5, x: 10, y: -5 }, typeFilter: { entityTypes: ['part'], relationshipTypes: ['HAS'] } });
    reopened.sync.flush();
    await suite.advance(AUTOSAVE_DELAY_MS);
    expect(draftWrites(reopened)).toEqual([]);
    expect(suite.draft()).toEqual(before);
  });

  it('keeps each hidden item hidden and each visible item visible after a hidden and a visible item swap places', async () => {
    suite = await startSuite();
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    const id = tab.state.investigation.getState().id ?? '';
    await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')]);
    const at = (stableId: string) => tab.nodeKey('leaf', stableId);
    tab.state.presentation.setPositions(new Map([[at('L-1'), { x: 100, y: 0 }], [at('L-2'), { x: 200, y: 0 }]]));
    tab.state.hide([at('L-1')]);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    tab.state.presentation.setPositions(new Map([[at('L-1'), { x: 200, y: 0 }], [at('L-2'), { x: 100, y: 0 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    const reopened = await reopen(suite, id);
    const view = reopened.state.presentation.view.getState();
    expect([...view.hidden]).toEqual([at('L-1')]);
    expect(view.positions.get(at('L-1'))).toEqual({ x: 200, y: 0 });
    expect(view.positions.get(at('L-2'))).toEqual({ x: 100, y: 0 });
    expect(reopened.canonical()).toBe(tab.canonical());
  });

  it('keeps a property filter the stored draft holds through the open and the next write', async () => {
    suite = await startSuite();
    const { tab, id } = await arranged(suite);
    const stored = suite.draft();
    if (stored === undefined) throw new Error('the draft was stored');
    const filters = { entityTypes: ['hub', 'leaf'], relTypes: [], time: null, properties: [{ key: 'weight', op: 'gte' as const, values: ['3'] }] };
    const written = await tab.client.saveDraft(id, stored.version, { notes: null, layout: stored.layout, queryContext: { ...stored.queryContext, filters } });
    expect(written).toMatchObject({ ok: true });
    expect(suite.draft()?.queryContext.filters.properties).toEqual(filters.properties);
    const reopened = await reopen(suite, id);
    reopened.state.presentation.setPositions(new Map([[reopened.nodeKey('leaf', 'L-1'), { x: 1, y: 2 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await reopened.written();
    expect(suite.draft()?.queryContext.filters.properties).toEqual(filters.properties);
  });

  it('is read again by reference: in batches of at most the number one call takes, and none for an entity the draft does not name', async () => {
    const world = new World().entity('hub', 'H-1');
    const leaves = Array.from({ length: 230 }, (_unused, index) => `L-${index + 1}`);
    for (const leaf of leaves) world.entity('leaf', leaf);
    world.entity('leaf', 'NOT-NAMED');
    suite = await startSuite({ world });
    const tab = suite.tab();
    await tab.open(ref('hub', 'H-1'));
    const id = tab.state.investigation.getState().id ?? '';
    for (let at = 0; at < leaves.length; at += MAX_READ_REFS) await tab.load(leaves.slice(at, at + MAX_READ_REFS).map((leaf) => ref('leaf', leaf)));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    const readsBefore = suite.dataReads().length;
    const reopened = suite.tab();
    await reopened.openById(id);
    expect(reopened.sourceReads()).toEqual(['POST /v1/graph/read-refs', 'POST /v1/graph/read-refs', 'POST /v1/graph/read-refs']);
    const calls = suite.dataReads().slice(readsBefore);
    const asked = idsRead(calls);
    const sizes = calls.filter((call) => call.templateId === 'entity-load-many').map((call) => (call.parameters['refs'] as unknown[]).length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(231);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_READ_REFS);
    expect(sizes.length).toBeLessThan(231 / 10);
    expect(asked).toHaveLength(231);
    expect(new Set(asked)).toEqual(new Set(['H-1', ...leaves]));
    expect(asked).not.toContain('NOT-NAMED');
  });
});

describe('a named view restored into the draft', () => {
  it('shows the state at the save and takes its note, after the draft changed', async () => {
    suite = await startSuite();
    const { tab, id } = await arranged(suite);
    const saved = tab.canonical();
    expect(await saveNamedView(tab.client, tab.state, { name: 'Before the change', notes: 'two leaves are the same company' })).toEqual({ kind: 'saved' });
    tab.state.presentation.showAllHidden();
    tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x: -1, y: -1 }]]));
    tab.state.presentation.unpin([tab.nodeKey('hub', 'H-1')]);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect(tab.canonical()).not.toBe(saved);
    const listed = await tab.client.listViews(id, {});
    const view = listed.ok ? listed.value.items[0] : undefined;
    if (view === undefined) throw new Error('the view was listed');
    expect(await restoreNamedView(tab.client, tab.state, view.id)).toMatchObject({ kind: 'restored' });
    expect(tab.canonical()).toBe(saved);
    expect(suite.draft()?.notes).toBe('two leaves are the same company');
    const reopened = await reopen(suite, id);
    expect(reopened.canonical()).toBe(saved);
  });
});

describe('every kind of relationship a draft names', () => {
  const end = (stableId: string, entityType = 'maker') => ({ sourceId: SOURCE, entityType, stableId });
  const label = (cypher: string) => /\(n:`([^`]+)`\)/.exec(cypher)?.[1];
  const entities = (call: { readonly templateId: string; readonly cypher: string; readonly parameters: Readonly<Record<string, unknown>> }) => {
    const make = (id: string) => (label(call.cypher) === 'Tool' ? device(id) : account(id));
    if (call.templateId === 'entity-load-many') return { status: 'rows' as const, rows: (call.parameters['refs'] as readonly { readonly stableId: string }[]).map((each, i) => ({ i, n: make(each.stableId), dup: false })) };
    if (call.templateId !== 'entity-load') return undefined;
    return entityRows(make(String(call.parameters['stableId'])));
  };

  it('restores a stored relationship and a derived one, with the rule and the supports', async () => {
    const mapping = parseMapping(fileOf(baseSource({ id: SOURCE, entities: DERIVED_ENTITIES, relationships: DERIVED_STORED, derived: [DERIVED_RULE] })), 'neburyx.yaml');
    const a1 = account('A-1');
    const d1 = device('D-1');
    suite = await startSuite({
      mapping,
      answer: (call) => {
        if (call.templateId === DERIVED_EDGE_SUPPORT_ID) return { status: 'rows', rows: JSON.stringify(call.parameters).includes('A-2') ? [chain('A-1', 'A-2', 'D-1')] : [] };
        if (call.templateId === 'edge-load') return { status: 'rows', rows: [{ r: uses(a1, d1, 'A-1-D-1'), a: a1, b: d1 }] };
        if (call.templateId === 'edge-load-many') return { status: 'rows' as const, rows: [{ i: 0, dup: false, r: uses(a1, d1, 'A-1-D-1'), a: a1, b: d1 }] };
        return entities(call);
      },
    });
    const tab = suite.tab();
    await tab.open(end('A-1'));
    const id = tab.state.investigation.getState().id ?? '';
    await tab.load([end('A-2'), end('D-1', 'tool')], [{ sourceId: SOURCE, type: 'USES_TOOL', from: 'maker', to: 'tool', stableId: 'A-1-D-1' }], { derived: [{ sourceId: SOURCE, derived: { ruleId: 'shared-tool', from: end('A-1'), to: end('A-2') } }] });
    expect(tab.state.loadedGraph().edges.map((edge) => edge.semantics).sort()).toEqual(['derived', 'stored']);
    tab.state.presentation.setPositions(new Map([[tab.nodeKey('maker', 'A-2'), { x: 7, y: 8 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    const reopened = suite.tab();
    await reopened.openById(id);
    expect(reopened.canonical()).toBe(tab.canonical());
    expect(reopened.state.loadedGraph().edges.find((edge) => edge.semantics === 'derived')?.derivation).toMatchObject({ ruleId: 'shared-tool', ruleVersion: 2 });
  });

  it('restores an aggregate relationship with its member count and its label', async () => {
    const mapping = parseMapping(fileOf(baseSource({ id: SOURCE, entities: DERIVED_ENTITIES, relationships: [...DERIVED_AGGREGATE], derived: [DERIVED_RULE] })), 'neburyx.yaml');
    const time = (day: number) => ({ $type: 'dateTime', value: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z` });
    suite = await startSuite({
      mapping,
      answer: (call) => {
        if (call.templateId === AGGREGATE_SAMPLE_ID) return { status: 'rows', rows: [{ a: account('A-1'), b: device('D-1'), sample: [{ t: time(1) }, { t: time(2) }, { t: time(3) }] }] };
        if (call.templateId === AGGREGATE_SUMMARY_ID) return { status: 'rows', rows: [{ members: 3, first: time(1), last: time(3) }] };
        return entities(call);
      },
    });
    const tab = suite.tab();
    await tab.open(end('A-1'));
    const id = tab.state.investigation.getState().id ?? '';
    await tab.load([end('D-1', 'tool')], [], { aggregates: [{ sourceId: SOURCE, aggregate: { type: 'USES_TOOL', from: end('A-1'), to: end('D-1', 'tool') } }] });
    tab.state.presentation.setPositions(new Map([[tab.nodeKey('tool', 'D-1'), { x: 3, y: 4 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    const reopened = suite.tab();
    await reopened.openById(id);
    expect(reopened.canonical()).toBe(tab.canonical());
    expect(reopened.state.loadedGraph().edges[0]).toMatchObject({ memberCount: { value: 3, quality: 'exact' } });
  });
});
