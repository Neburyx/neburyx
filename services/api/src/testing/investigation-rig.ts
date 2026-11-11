import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { openInvestigationResponseSchema, saveViewResponseSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { createLogger } from '../logger.js';
import type { MappingModel } from '../mapping/model.js';
import { entityRows, plainNode } from './entity-fixtures.js';
import { TestExecutor } from './gate.js';
import { runCli } from './cli.js';
import { withOnlineIndexes } from './search-fixtures.js';
import { testSourceGate } from './source-gate.js';
import { webRoot } from './start-api.js';
import type { TestPostgres } from './postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const json = { 'content-type': 'application/json' };

/** The stores a rig opened, for the file to close when it is done. */
export const rigStores: AppStore[] = [];

export async function startRig(postgres: TestPostgres, appMapping: MappingModel, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const database = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  rigStores.push(store);
  await store.initialize();
  await store.syncSources(appMapping.sources);
  const source = appMapping.sources[0];
  if (source === undefined) throw new Error('the mapping has a source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => {
    // a batched read answers a row for each reference it holds, with the position of the reference in the list
    if (call.templateId === 'entity-load-many') {
      const refs = Array.isArray(call.parameters['refs']) ? call.parameters['refs'] : [];
      return Promise.resolve({ status: 'rows', rows: refs.map((_ref, i) => ({ i, dup: false, n: WIDGET })) });
    }
    return Promise.resolve(entityRows(WIDGET));
  }));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { executor }).gate, ...extra });
  const get = (url: string) => app.inject({ method: 'GET', url });
  const open = async (caseRef?: string) => {
    const response = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, ...(caseRef === undefined ? {} : { caseRef }) } });
    return openInvestigationResponseSchema.parse(response.json());
  };
  const saveView = async (investigationId: string, draftVersion: number, name = 'A view') => {
    const response = await app.inject({ method: 'POST', url: `/v1/investigations/${investigationId}/views`, headers: { ...json, 'if-match': `"${draftVersion}"` }, payload: { name, notes: null } });
    expect(response.statusCode).toBe(201);
    return saveViewResponseSchema.parse(response.json());
  };
  const removeInvestigation = (id: string, version: number) => app.inject({ method: 'DELETE', url: `/v1/investigations/${id}`, headers: { 'if-match': `"${version}"` } });
  const restoreInvestigation = (id: string, version: number) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/restore`, headers: json, payload: { expectedVersion: version } });
  const removeView = (id: string, viewId: string, version: number, note?: string) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${viewId}/delete`, headers: { ...json, 'if-match': `"${version}"` }, payload: note === undefined ? {} : { note } });
  const renameView = (id: string, viewId: string, version: number, name: string) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}/views/${viewId}`, headers: { ...json, 'if-match': `"${version}"` }, payload: { name } });
  const restoreView = (id: string, viewId: string, draftVersion: number) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/views/${viewId}/restore`, headers: { 'if-match': `"${draftVersion}"` } });
  return { database, store, app, get, open, saveView, removeInvestigation, restoreInvestigation, removeView, renameView, restoreView };
}

