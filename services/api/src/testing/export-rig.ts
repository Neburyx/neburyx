import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInvestigationResponseSchema } from '@neburyx/contracts';
import { stringify } from 'yaml';
import { buildApp } from '../app.js';
import { createExportFileStore } from '../exports/store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { redactItems } from '../gate/redact/index.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from './app-store.js';
import { hidingRedact } from './derived-fixtures.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from './gate.js';
import { baseSource, fileOf } from './mapping.js';
import { plainNode, plainRelationship } from './normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from './search-fixtures.js';
import { testSourceGate } from './source-gate.js';
import { makeWebRoot } from './web-root.js';

export const exportWebRoot = makeWebRoot();

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId' }];

export const exportMapping = (extra: { readonly userConcurrency?: number; readonly requestsPerMinute?: number; readonly retention?: { readonly exports_days: number } } = {}) => {
  const source = baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS, ...(extra.userConcurrency === undefined && extra.requestsPerMinute === undefined ? {} : { budgets: { ...(extra.userConcurrency === undefined ? {} : { user_concurrency: extra.userConcurrency }), ...(extra.requestsPerMinute === undefined ? {} : { requests_per_minute: extra.requestsPerMinute }) } }) });
  const text = extra.retention === undefined ? fileOf(source) : stringify({ sources: [source], retention: extra.retention }, { aliasDuplicateObjects: false, blockQuote: false });
  return parseMapping(text, 'neburyx.yaml');
};

export const widget = (id: string, name = 'Ana Silva') => plainNode(['Widget'], { widgetId: id, ownerName: name }, `4:s:${id}`);
export const gadget = (id = 'GT-1') => plainNode(['Gadget'], { gadgetId: id }, `4:s:${id}`);
export const link = (id: string, from = 'W-1') => ({ r: plainRelationship('MADE_FROM', widget(from), gadget(), { linkId: id }, `5:s:${id}`), a: widget(from), b: gadget() });
export const el = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
export const linkRef = (id: string) => ({ sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: id });

export interface ExportRigOptions {
  readonly widgets?: readonly string[] | ((id: string) => boolean);
  readonly links?: readonly string[];
  readonly name?: (id: string) => string;
  readonly userConcurrency?: number;
  readonly requestsPerMinute?: number;
  readonly retention?: { readonly exports_days: number };
  readonly deny?: () => boolean;
  readonly policyVersion?: () => string;
  readonly hideNode?: string;
  readonly failAudit?: (action: string) => boolean;
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome | undefined;
}

const json = { 'content-type': 'application/json' };
let sequence = 0;

export async function startExportRig(options: ExportRigOptions = {}) {
  const mapping = exportMapping({ ...(options.userConcurrency === undefined ? {} : { userConcurrency: options.userConcurrency }), ...(options.requestsPerMinute === undefined ? {} : { requestsPerMinute: options.requestsPerMinute }), ...(options.retention === undefined ? {} : { retention: options.retention }) });
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has a source');
  const known = (id: string): boolean => (typeof options.widgets === 'function' ? options.widgets(id) : (options.widgets ?? ['W-1', 'W-2']).includes(id));
  const executor = new TestExecutor(
    withSchema(
      () => schemaAnswer(onlineIndexesOf(source)),
      async (call): Promise<ExecuteOutcome> => {
        const custom = options.answer?.(call);
        if (custom !== undefined) return custom;
        const id = String(call.parameters['stableId']);
        if (call.templateId === 'entity-load') {
          if (known(id)) return { status: 'rows', rows: [{ n: widget(id, options.name?.(id) ?? 'Ana Silva') }] };
          if (id === 'GT-1') return { status: 'rows', rows: [{ n: gadget() }] };
          return { status: 'rows', rows: [] };
        }
        if (call.templateId === 'edge-load' && (options.links ?? []).includes(id)) return { status: 'rows', rows: [link(id)] };
        return { status: 'rows', rows: [] };
      },
    ),
  );
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: { authorizeSource: () => Promise.resolve(options.deny?.() === true ? { allowed: false, reason: 'no' } : { allowed: true }) },
    coordinator: defaults.coordinator,
    audit: {
      record: (event) => {
        if (options.failAudit?.(event.action) === true) return Promise.reject(new Error('the sink is down'));
        events.push(event);
        return Promise.resolve();
      },
    },
  };
  const redact = options.hideNode === undefined ? undefined : hidingRedact(options.hideNode, redactItems);
  const parts = testSourceGate(mapping, { executor, seams, referenceKeys: TEST_REFERENCE_KEYS, ...(redact === undefined ? {} : { redact }) });
  const directory = join(mkdtempSync(join(tmpdir(), 'nbx-export-rig-')), 'exports');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = createExportFileStore(directory);
  const store = memoryAppStore();
  const app = await buildApp({
    webRoot: exportWebRoot,
    logger: createLogger({ write: () => undefined }),
    store,
    mapping,
    gate: parts.gate,
    seams: { ...defaults, ...seams },
    referenceKeys: TEST_REFERENCE_KEYS,
    exportFiles: files,
    ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
  });
  await store.syncSources(mapping.sources);

  const open = async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } } });
    return openInvestigationResponseSchema.parse(response.json()).investigation;
  };
  const newKey = (): string => `key-${String((sequence += 1)).padStart(12, '0')}-abcdef`;
  const create = (id: string, body: unknown, key: string | null = newKey()) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/exports`, headers: { ...json, ...(key === null ? {} : { 'idempotency-key': key }) }, payload: body as object });
  const get = (id: string) => app.inject({ method: 'GET', url: `/v1/exports/${id}` });
  const download = (id: string) => app.inject({ method: 'GET', url: `/v1/exports/${id}/download` });
  const stop = async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { app, store, files, directory, events, executor, mapping, open, create, get, download, newKey, stop };
}

export type ExportRig = Awaited<ReturnType<typeof startExportRig>>;
