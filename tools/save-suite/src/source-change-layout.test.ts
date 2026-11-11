import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NOT_READ_FLAG } from '../../../apps/web/src/draft/unmapped.js';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { identityHashOf } from '../../../services/api/src/registry/identity-hash.js';
import { reportFromServer } from '../../../services/api/src/source-test/report.js';
import { runSourceRebindCommand } from '../../../services/api/src/source-rebind/command.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { AUTOSAVE_DELAY_MS, ENTITY_TYPES, mappingOf, ref, RELATIONSHIP_TYPES, startSuite, type Suite, type Tab } from './rig.js';

const folder = mkdtempSync(join(tmpdir(), 'save-suite-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const SOURCE_CHANGED = (state: 'repointed' | 'removed') => ({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'source-changed', sourceState: state } } });
const REPOINTED = () => mappingOf({ database: 'a-different-database' });
const REMOVED = () => parseMapping(fileOf(baseSource({ id: 'other', entities: ENTITY_TYPES, relationships: RELATIONSHIP_TYPES })), 'neburyx.yaml');

/** An investigation with a layout, a pin, a hidden item and a named view, saved while the source is as it was. */
async function saved(running: Suite): Promise<{ readonly id: string; readonly viewId: string; readonly canonical: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')]);
  tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x: 80, y: -20 }], [tab.nodeKey('leaf', 'L-2'), { x: -60, y: 15 }]]));
  tab.state.presentation.pin([tab.nodeKey('leaf', 'L-1')]);
  tab.state.hide([tab.nodeKey('leaf', 'L-2')]);
  tab.state.presentation.setLayout('grid');
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  expect(await saveNamedView(tab.client, tab.state, { name: 'Before', notes: null })).toEqual({ kind: 'saved' });
  const canonical = tab.canonical();
  tab.dispose();
  return { id, viewId: running.store.namedViews[0]?.id ?? '', canonical };
}

describe.each([
  ['repointed', REPOINTED],
  ['removed', REMOVED],
] as const)('an investigation whose source was %s', (state, changed) => {
  it('shows the saved layout from the draft alone: each item a placeholder with its position, pin and hidden flag', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    await suite.restart(changed());
    const tab = suite.tab();
    expect(await tab.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(tab.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'L-2']);
    expect(tab.state.loadedGraph().nodes.every((node) => node.qualityFlags.includes(NOT_READ_FLAG))).toBe(true);
    const view = tab.state.presentation.view.getState();
    expect(view.positions.get(tab.nodeKey('leaf', 'L-1'))).toEqual({ x: 80, y: -20 });
    expect([...view.pins]).toEqual([tab.nodeKey('leaf', 'L-1')]);
    expect([...view.hidden]).toEqual([tab.nodeKey('leaf', 'L-2')]);
    expect(view.layout).toBe('grid');
    expect(tab.state.investigation.getState().record).toMatchObject({ readOnly: true, sourceState: state });
  });

  it('refuses a view save, rename, restore and delete, a title rename and a draft write with source-changed, answers the list of views, and reads the source not at all', async () => {
    suite = await startSuite();
    const { id, viewId } = await saved(suite);
    await suite.restart(changed());
    const tab = suite.tab();
    await tab.openById(id);
    const stored = structuredClone({ draft: suite.draft(), views: suite.store.namedViews });
    const version = suite.draft()?.version ?? 1;
    const refused = SOURCE_CHANGED(state);
    expect(await tab.client.saveView(id, version, { name: 'After', notes: null })).toMatchObject(refused);
    expect(await tab.client.renameView(id, viewId, 1, 'After')).toMatchObject(refused);
    expect(await tab.client.restoreView(id, viewId, version)).toMatchObject(refused);
    expect(await tab.client.deleteView(id, viewId, 1, null)).toMatchObject(refused);
    expect(await tab.client.renameInvestigation(id, 'After', 1)).toMatchObject(refused);
    expect(await tab.client.saveDraft(id, version, { notes: null, layout: stored.draft?.layout, queryContext: stored.draft?.queryContext } as Parameters<Tab['client']['saveDraft']>[2])).toMatchObject(refused);
    expect(await tab.client.listViews(id, {})).toMatchObject({ ok: true, value: { items: [{ id: viewId }] } });
    expect({ draft: suite.draft(), views: suite.store.namedViews }).toEqual(stored);
    expect(suite.executor.calls).toEqual([]);
    expect(tab.sourceReads()).toEqual([]);
  });

  it('accepts a status change and a delete, still without a read', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    await suite.restart(changed());
    const tab = suite.tab();
    await tab.openById(id);
    const read = await tab.client.getInvestigation(id);
    const version = read.ok ? read.value.investigation.version : 0;
    const closed = await tab.client.changeInvestigationStatus(id, 'closed', version);
    expect(closed).toMatchObject({ ok: true });
    expect(await tab.client.deleteInvestigation(id, closed.ok ? closed.value.investigation.version : 0)).toMatchObject({ ok: true });
    expect(await tab.client.getInvestigation(id)).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(suite.executor.calls).toEqual([]);
  });
});

describe('an investigation of a source that was re-pointed, after the rebind command', () => {
  it('opens with the pins, hidden flags and positions that were saved before the source changed', async () => {
    suite = await startSuite();
    const { id, canonical } = await saved(suite);
    const next = REPOINTED();
    await suite.restart(next);
    const [source] = next.sources;
    if (source === undefined) throw new Error('the mapping has a source');
    await suite.store.recordSourceCheck({ id: 'check-1', report: reportFromServer(source, { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] }, false, '2026-11-10T10:00:00.000Z'), triggeredBy: null, identityHash: identityHashOf(source), configHash: source.configHash });
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(baseSource({ id: 'demo', database: 'a-different-database', entities: ENTITY_TYPES, relationships: RELATIONSHIP_TYPES })));
    let out = '';
    let err = '';
    const code = await runSourceRebindCommand(['rebind', 'demo', '--confirm', 'demo'], { DATABASE_URL: 'postgres://u:p@h.example.test/db', NEBURYX_CONFIG: file }, { stdout: { write: (text) => (out += text) }, stderr: { write: (text) => (err += text) }, openStore: () => ({ rebindSource: suite?.store.rebindSource ?? (() => Promise.reject(new Error('no store'))), close: () => Promise.resolve() }) });
    expect({ code, out, err }).toEqual({ code: 0, out: 'Source: demo\nInvestigations rebound: 1\n', err: '' });

    const tab = suite.tab();
    expect(await tab.openById(id)).toMatchObject({ kind: 'shown', id });
    tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
    expect(tab.state.investigation.getState().record).toMatchObject({ readOnly: false, sourceState: 'available' });
    expect(tab.canonical()).toBe(canonical);
  });
});
