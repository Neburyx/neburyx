import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { exportFileSchema } from '@neburyx/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { keyAfter } from '../../../apps/web/src/exports/export-attempt.js';
import { exportBlockedOf } from '../../../apps/web/src/state/investigation-state.js';
import { expireExports } from '../../../services/api/src/jobs/maintenance.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { downloaded, made, newKey, removeExportFolder, reopened, request, unzipped, viewRequest, zipPath } from './export-helpers.js';
import { ENTITY_TYPES, mappingOf, ref, RELATIONSHIP_TYPES, startSuite, type Suite, type Tab } from './rig.js';
import { LINKED } from './scenarios.js';

afterAll(removeExportFolder);

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const silent = createLogger({ write: () => undefined });
const DAY_MS = 86_400_000;
const NOT_FOUND = { ok: false, failure: { code: 'NOT_FOUND' } };
const SOURCE_CHANGED = (state: 'repointed' | 'removed') => ({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'source-changed', sourceState: state } } });

/** Everything in the export directory, finished or temporary. */
const files = (running: Suite): string[] => readdirSync(running.exportDirectory);
const exportRows = (running: Suite) => running.store.exports.rows;
const maintenance = (running: Suite) => ({ store: running.store, exports: running.store, files: running.exportFiles, audit: { record: () => Promise.resolve() }, logger: silent });
/** The failure of a refused call without what is different for every call. */
const withoutTrace = (answer: { readonly ok: boolean; readonly failure?: object }) => {
  const { traceId: _trace, ...rest } = (answer.failure ?? {}) as { traceId?: string };
  return rest;
};
const stampOf = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

describe('the header of an export of a saved investigation', () => {
  it('holds what the canvas of the reopened investigation shows, with the source, the time, the partial scope, the shown count, the not-retrieved line without an invented number, and masking off, in a JSON file', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const shown = tab.state.visibleGraph();
    // the arrangement hides one item and filters one type out: both are loaded and neither is shown
    const loaded = tab.state.loadedGraph().nodes.map((node) => node.ref.stableId);
    expect(loaded).toEqual(expect.arrayContaining(['L-3', 'P-1']));
    expect(shown.nodes.length).toBeLessThan(tab.state.loadedGraph().nodes.length);
    const before = Date.now();
    const { file, record } = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const after = Date.now();
    const parsed = exportFileSchema.parse(JSON.parse(await file.blob.text()));
    const ids = parsed.entities.map((node) => node.ref.stableId);
    expect([...ids].sort()).toEqual(shown.nodes.map((node) => node.ref.stableId).sort());
    expect(ids).not.toContain('L-3');
    expect(ids).not.toContain('P-1');
    expect(parsed.relationships.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')).sort()).toEqual(shown.edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')).sort());
    const { header } = parsed;
    expect(header.lines).toEqual(['source: demo', `exported: ${header.exported}`, 'scope: current view (partial)', `coverage: ${String(shown.nodes.length)} shown · more not yet retrieved`, 'masking: off']);
    expect(header).toMatchObject({ source: 'demo', scope: 'current view (partial)', masking: 'off', coverage: { shown: shown.nodes.length, notRetrieved: { quality: 'unknown' } } });
    expect(header.coverage.notRetrieved).not.toHaveProperty('value');
    expect(header.exported).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(header.exported)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(header.exported)).toBeLessThanOrEqual(after + 1000);
    expect(file.filename).toBe(record.filename);
    expect(file.filename).toBe(`neburyx-export-${stampOf(header.exported)}.json`);
  });

  it('puts the same header lines at the top of both files of a CSV export, as the JSON export of the same view does, with the time of its file name', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const shown = tab.state.visibleGraph();
    const json = exportFileSchema.parse(JSON.parse(await (await made(tab, id, 'json', viewRequest(tab, 'json'))).file.blob.text()));
    const { file } = await made(tab, id, 'csv', viewRequest(tab, 'csv'));
    const text = unzipped(Buffer.from(await file.blob.arrayBuffer()), ['entities.csv', 'relationships.csv']);
    for (const [name, body] of Object.entries(text)) {
      expect(body.startsWith('﻿'), `${name} starts with a byte-order mark`).toBe(true);
      const lines = body.slice(1).split('\r\n').slice(0, 5);
      expect(lines.every((line) => /^"# .*"$/.test(line)), `${name} holds one quoted field a line`).toBe(true);
      const [source, exported, scope, coverage, masking] = lines.map((line) => line.slice(3, -1));
      expect([source, scope, coverage, masking], name).toEqual([json.header.lines[0], json.header.lines[2], json.header.lines[3], json.header.lines[4]]);
      expect(exported, name).toMatch(/^exported: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(file.filename, name).toBe(`neburyx-export-${stampOf((exported ?? '').slice('exported: '.length))}.zip`);
    }
    const path = zipPath(Buffer.from(await file.blob.arrayBuffer()));
    expect(execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n')).toEqual(['entities.csv', 'relationships.csv']);
    const rows = (text['entities.csv'] ?? '').slice(1).split('\r\n').slice(5, -1);
    expect(rows.length).toBe(shown.nodes.length + 1);
    const idsInCsv = rows.slice(1).map((row) => row.split(',')[1]?.replace(/^"|"$/g, ''));
    expect([...idsInCsv].sort()).toEqual(shown.nodes.map((node) => node.ref.stableId).sort());
  });

  it('names the source of the investigation, as the dialog previews it, and holds the elements the request named and no others', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const { file } = await made(tab, id, 'json', { entities: [ref('hub', 'H-1'), ref('leaf', 'L-1')], edges: [LINKED('r-L1')] });
    const parsed = exportFileSchema.parse(JSON.parse(await file.blob.text()));
    expect(parsed.header.source).toBe(tab.state.investigation.getState().sourceId);
    expect(parsed.entities.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1']);
    expect(parsed.relationships.map((edge) => edge.ref)).toEqual([expect.objectContaining({ stableId: 'r-L1' })]);
    expect(parsed.header.coverage.shown).toBe(2);
  });
});

describe('the not-yet-retrieved line of an export', () => {
  const DEGREES: Readonly<Record<string, readonly number[]>> = { 'H-1': [5, 2], 'L-1': [1], 'L-2': [1], 'L-4': [1] };
  const answer = (call: { readonly templateId: string; readonly parameters: Readonly<Record<string, unknown>> }) => {
    if (!call.templateId.startsWith('degree-preview')) return undefined;
    const counts = DEGREES[String(call.parameters['stableId'])] ?? [0];
    return { status: 'rows' as const, rows: [Object.fromEntries(counts.map((count, index) => [`c${String(index)}`, count]))] };
  };
  const preview = (tab: Tab, entityType: string, stableId: string) => tab.client.previewExpansion({ sourceId: 'demo', ref: { entityType, stableId }, mask: false });

  it('states a counted figure, as the previews counted it and labelled estimated, never exact, since a relationship between two shown entities is counted at both ends', async () => {
    suite = await startSuite({ answer });
    const { tab, id } = await reopened(suite);
    for (const [type, stable] of [['hub', 'H-1'], ['leaf', 'L-1'], ['leaf', 'L-2'], ['leaf', 'L-4']] as const) expect(await preview(tab, type, stable)).toMatchObject({ ok: true });
    const request = viewRequest(tab, 'json');
    const { file } = await made(tab, id, 'json', request);
    const { header } = exportFileSchema.parse(JSON.parse(await file.blob.text()));
    // the hub has 7 (5 and 2) and each of three leaves 1; the file holds the stored relationships of the request
    const remaining = 7 + 1 + 1 + 1 - request.edges.length * 2;
    expect(remaining).toBe(6);
    expect(header.coverage.notRetrieved).toMatchObject({ quality: 'estimated', value: remaining });
    expect(header.lines[3]).toBe(`coverage: 4 shown · ~${String(remaining)} not yet retrieved (estimated)`);
  });

  it('states a lower bound, not a total, when only some of the shown entities were previewed', async () => {
    suite = await startSuite({ answer });
    const { tab, id } = await reopened(suite);
    expect(await preview(tab, 'hub', 'H-1')).toMatchObject({ ok: true });
    const request = viewRequest(tab, 'json');
    expect(request.edges).toHaveLength(2);
    const { file } = await made(tab, id, 'json', request);
    const { header } = exportFileSchema.parse(JSON.parse(await file.blob.text()));
    expect(header.coverage.notRetrieved).toMatchObject({ quality: 'lowerBound', value: 5 });
    expect(header.lines[3]).toBe(`coverage: 4 shown · ≥ 5 not yet retrieved (lower bound)`);
  });

  it('states no number when nothing about the shown entities was previewed', async () => {
    suite = await startSuite({ answer });
    const { tab, id } = await reopened(suite);
    const { file } = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const { header } = exportFileSchema.parse(JSON.parse(await file.blob.text()));
    expect(header.coverage.notRetrieved).toMatchObject({ quality: 'unknown' });
    expect(header.coverage.notRetrieved).not.toHaveProperty('value');
    expect(header.lines[3]).toBe('coverage: 4 shown · more not yet retrieved');
  });
});

describe('the size an export may hold', () => {
  const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ref('leaf', `${prefix}-${String(index)}`));
  const stored = (count: number) => Array.from({ length: count }, (_, index) => LINKED(`r-X${String(index)}`));
  const aggregates = (count: number) => Array.from({ length: count }, (_, index) => ({ sourceId: 'demo', aggregate: { type: 'LINKED', from: ref('hub', 'H-1'), to: ref('leaf', `LA-${String(index)}`) } }));
  const derived = (count: number) => Array.from({ length: count }, (_, index) => ({ sourceId: 'demo', derived: { ruleId: 'rule', from: ref('hub', 'H-1'), to: ref('leaf', `LD-${String(index)}`) } }));
  const LIMITS = { maxEntities: 300, maxRelationships: 300, maxAggregates: 100 };

  const CASES_0 = [
    ['301 entities', () => ({ entities: many(301, 'E') }), 'entities'],
    ['301 stored relationships', () => ({ edges: stored(301) }), 'relationships'],
    ['101 aggregated relationships', () => ({ aggregates: aggregates(101) }), 'aggregates'],
    ['51 aggregated and 50 derived relationships, which count together', () => ({ aggregates: aggregates(51), derived: derived(50) }), 'aggregates'],
  ] as const;
  for (const [name, over, exceeded] of CASES_0) it(`refuses ${name} through the web client, with the limits, no row, no file of any name and no read of the source`, async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const reads = suite.dataReads().length;
    const refused = await tab.client.createExport(id, request('json', { entities: [], edges: [], ...over() }), newKey());
    expect(refused).toMatchObject({ ok: false, failure: { code: 'INVALID_REQUEST', details: { reason: 'export-too-large', ...LIMITS, exceeded } } });
    expect(exportRows(suite)).toEqual([]);
    expect(files(suite)).toEqual([]);
    expect(suite.dataReads().length).toBe(reads);
  });

  const CASES_1 = [
    ['300 entities and 300 stored relationships', () => ({ entities: many(300, 'E'), edges: stored(300) })],
    ['50 aggregated and 50 derived relationships', () => ({ entities: [], edges: [], aggregates: aggregates(50), derived: derived(50) })],
    ['300 entities, 300 stored and 100 aggregated relationships', () => ({ entities: many(300, 'E'), edges: stored(300), aggregates: aggregates(100) })],
  ] as const;
  for (const [name, over] of CASES_1) it(`accepts ${name}, and reads the source to do it`, async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const reads = suite.dataReads().length;
    expect(await tab.client.createExport(id, request('json', over()), newKey())).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(suite.dataReads().length).toBeGreaterThan(reads);
    expect(exportRows(suite)).toHaveLength(1);
  });

  it('keeps the refusal for its key, so the retry after it takes a new key and, with fewer items, succeeds', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const key = newKey();
    const tooMany = request('json', { entities: many(301, 'E'), edges: [] });
    const refused = await tab.client.createExport(id, tooMany, key);
    if (refused.ok) throw new Error('the export was accepted');
    expect(await tab.client.createExport(id, tooMany, key)).toEqual(refused);
    const next = keyAfter(refused.failure, key);
    expect(next).not.toBe(key);
    expect(await tab.client.createExport(id, request('json', { entities: many(300, 'E'), edges: [] }), next)).toMatchObject({ ok: true });
  });
});

describe('an export of an investigation whose source changed', () => {
  const CHANGED = [
    ['repointed', () => mappingOf({ database: 'a-different-database' })],
    ['removed', () => parseMapping(fileOf(baseSource({ id: 'other', entities: ENTITY_TYPES, relationships: RELATIONSHIP_TYPES })), 'neburyx.yaml')],
  ] as const;
  for (const [state, changed] of CHANGED) it(`is refused when the source was ${state}, with its state, no read of the source, no row, no file, and the Export button of the tab is blocked`, async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const earlier = await made(tab, id, 'json', viewRequest(tab, 'json'));
    tab.dispose();
    await suite.restart(changed());
    const fresh = suite.tab();
    expect(await fresh.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(exportBlockedOf(fresh.state.investigation.getState().record)).toBe(true);
    const reads = suite.dataReads().length;
    const rowsBefore = exportRows(suite).length;
    const filesBefore = files(suite);
    expect(await fresh.client.createExport(id, request('json'), newKey())).toMatchObject(SOURCE_CHANGED(state));
    expect(suite.dataReads().length).toBe(reads);
    expect(exportRows(suite)).toHaveLength(rowsBefore);
    expect(files(suite)).toEqual(filesBefore);
    // an export made before the change is refused, its file deleted and its row expired; a download reads nothing either way
    expect(await fresh.client.downloadExport(earlier.record.id)).toMatchObject({ ok: false, failure: { code: 'ACCESS_DENIED', details: { reason: 'export-source-changed' } } });
    expect(files(suite)).toEqual([]);
    expect(await fresh.client.downloadExport(earlier.record.id)).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
    expect(suite.dataReads().length).toBe(reads);
  });

  it('leaves the Export button available when the source is as it was', async () => {
    suite = await startSuite();
    const { tab } = await reopened(suite);
    expect(exportBlockedOf(tab.state.investigation.getState().record)).toBe(false);
  });
});

describe('an export of a closed and of an archived investigation', () => {
  for (const status of ['closed', 'archived'] as const) it(`is made and downloaded in a tab that shows the investigation ${status} and read-only, and an earlier file downloads as it was`, async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const earlier = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const earlierBytes = await downloaded(tab, earlier.record.id);
    expect(tab.state.investigation.getState().record).toMatchObject({ readOnly: false });
    const read = await tab.client.getInvestigation(id);
    expect(await tab.client.changeInvestigationStatus(id, status, read.ok ? read.value.investigation.version : 0)).toMatchObject({ ok: true });

    const later = suite.tab();
    expect(await later.openById(id)).toMatchObject({ kind: 'shown', id });
    later.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
    expect(later.state.investigation.getState().record).toMatchObject({ status, readOnly: true });
    expect(exportBlockedOf(later.state.investigation.getState().record)).toBe(false);

    expect(await downloaded(later, earlier.record.id)).toEqual(earlierBytes);
    const json = await made(later, id, 'json', viewRequest(later, 'json'));
    const timeless = (bytes: Buffer) => {
      const file = exportFileSchema.parse(JSON.parse(bytes.toString('utf8')));
      return { ...file, header: { ...file.header, exported: '', lines: file.header.lines.filter((line) => !line.startsWith('exported: ')) } };
    };
    expect(timeless(await downloaded(later, json.record.id))).toEqual(timeless(earlierBytes));
    const csv = await made(later, id, 'csv', viewRequest(later, 'csv'));
    expect(csv.record.status).toBe('ready');
    expect(unzipped(await downloaded(later, csv.record.id), ['entities.csv'])['entities.csv']).toContain('# scope: current view (partial)');
  });
});

describe('an export past its expiry', () => {
  it('is cleared by the expiry task, which removes its file and marks its row expired, and a download then answers as for an unknown export', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const json = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const csv = await made(tab, id, 'csv', viewRequest(tab, 'csv'));
    expect(files(suite)).toHaveLength(2);
    expect(exportRows(suite).map((row) => row.status)).toEqual(['ready', 'ready']);
    suite.store.exports.clock.now += 31 * DAY_MS;

    // the task alone, before any download has met the expired export
    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 2, unnamedFiles: 0 });
    expect(files(suite)).toEqual([]);
    expect(exportRows(suite).map((row) => [row.status, row.storageKey])).toEqual([['expired', null], ['expired', null]]);

    const unknown = await tab.client.downloadExport('3b5a0f8e-1c2d-4e6f-8a9b-0c1d2e3f4a5b');
    expect(unknown).toMatchObject(NOT_FOUND);
    for (const record of [json.record, csv.record]) {
      const answer = await tab.client.downloadExport(record.id);
      expect(answer).toMatchObject(NOT_FOUND);
      expect(withoutTrace(answer)).toEqual(withoutTrace(unknown));
    }
    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 0 });
  });

  it('is answered as unknown, and its file removed, by a download that comes before the task runs', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const { record } = await made(tab, id, 'json', viewRequest(tab, 'json'));
    suite.store.exports.clock.now += 31 * DAY_MS;
    expect(await tab.client.downloadExport(record.id)).toMatchObject(NOT_FOUND);
    expect(files(suite)).toEqual([]);
    expect(exportRows(suite).map((row) => row.status)).toEqual(['expired']);
  });

  it('leaves an export that has not reached its expiry, with its file, and downloads it', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const { record } = await made(tab, id, 'json', viewRequest(tab, 'json'));
    suite.store.exports.clock.now += 1 * DAY_MS;
    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 0 });
    expect(files(suite)).toHaveLength(1);
    expect(await tab.client.downloadExport(record.id)).toMatchObject({ ok: true });
  });
});

describe('an export of an investigation that is deleted and restored', () => {
  it('is not found while the investigation is deleted, keeps its file, and downloads again, byte for byte, when it is restored', async () => {
    suite = await startSuite();
    const { tab, id } = await reopened(suite);
    const { record } = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const bytes = await downloaded(tab, record.id);
    const read = await tab.client.getInvestigation(id);
    const deleted = await tab.client.deleteInvestigation(id, read.ok ? read.value.investigation.version : 0);
    if (!deleted.ok) throw new Error('the investigation was deleted');
    expect(await tab.client.downloadExport(record.id)).toMatchObject(NOT_FOUND);
    expect(files(suite)).toHaveLength(1);
    expect(await tab.client.restoreInvestigation(id, deleted.value.version)).toMatchObject({ ok: true });
    expect(await downloaded(tab, record.id)).toEqual(bytes);
  });
});
