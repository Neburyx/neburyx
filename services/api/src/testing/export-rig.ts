import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInvestigationResponseSchema, type AuditCounts, type CaseSummarizer, type ProfileExtension } from '@neburyx/contracts';
import { stringify } from 'yaml';
import { buildApp } from '../app.js';
import { createExportFileStore } from '../exports/store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { redactItems } from '../gate/redact/index.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { queuedAudit } from './queued-audit.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, AuditSink, Seams } from '../seams/seams.js';
import { memoryAppStore } from './app-store.js';
import { hidingRedact } from './derived-fixtures.js';
import { TEST_REFERENCE_KEYS, TestExecutor } from './gate.js';
import { baseSource, fileOf } from './mapping.js';
import type { FileQueryDeps } from '../gate/file-query.js';
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

const exportMapping = (extra: { readonly synthetic?: boolean; readonly descriptions?: Readonly<Record<string, string>>; readonly userConcurrency?: number; readonly requestsPerMinute?: number; readonly retention?: { readonly exports_days: number } } = {}) => {
  const described = <T extends { readonly type: string }>(rows: readonly T[]) => rows.map((row) => (extra.descriptions?.[row.type] === undefined ? row : { ...row, description: extra.descriptions[row.type] }));
  const source = baseSource({ id: 'demo', ...(extra.synthetic === undefined ? {} : { synthetic: extra.synthetic }), entities: described(ENTITIES), relationships: described(RELATIONSHIPS), ...(extra.userConcurrency === undefined && extra.requestsPerMinute === undefined ? {} : { budgets: { ...(extra.userConcurrency === undefined ? {} : { user_concurrency: extra.userConcurrency }), ...(extra.requestsPerMinute === undefined ? {} : { requests_per_minute: extra.requestsPerMinute }) } }) });
  const text = extra.retention === undefined ? fileOf(source) : stringify({ sources: [source], retention: extra.retention }, { aliasDuplicateObjects: false, blockQuote: false });
  return parseMapping(text, 'neburyx.yaml');
};

export const widget = (id: string, name = 'Ana Silva') => plainNode(['Widget'], { widgetId: id, ownerName: name }, `4:s:${id}`);
export const gadget = (id = 'GT-1') => plainNode(['Gadget'], { gadgetId: id }, `4:s:${id}`);
const link = (id: string, from = 'W-1') => ({ r: plainRelationship('MADE_FROM', widget(from), gadget(), { linkId: id }, `5:s:${id}`), a: widget(from), b: gadget() });
export const el = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
export const linkRef = (id: string) => ({ sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: id });

export interface ExportRigOptions {
  /** The `synthetic` flag of the source in the mapping; absent, the mapping does not set it. */
  readonly synthetic?: boolean;
  readonly widgets?: readonly string[] | ((id: string) => boolean);
  readonly links?: readonly string[];
  readonly name?: (id: string) => string;
  readonly userConcurrency?: number;
  readonly requestsPerMinute?: number;
  /** A description for a type of the mapping, by the name of the type. */
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly retention?: { readonly exports_days: number };
  readonly deny?: () => boolean;
  /** Receives every log line of the application under test. */
  readonly logLines?: string[];
  readonly policyVersion?: () => string;
  readonly hideNode?: string;
  /** The stable ID of an entity the person may read but not export. */
  readonly unexportableNode?: string;
  readonly failAudit?: (action: string) => boolean;
  /** The application's audit member is the sink itself and not the queue in front of it: for the tests of the enterprise routes whose own handling of a failed event is rewritten with the queue. */
  readonly directAudit?: boolean;
  /** The application's audit member, for a test that builds the queue over its own store; takes the place of the queue the rig builds. */
  readonly auditMember?: AuditSink;
  /** What `GET /readyz` counts of the queues the test builds itself. */
  readonly auditCounts?: () => AuditCounts;
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome> | undefined;
  /** The stored file queries of an Ask folder, so the gate runs them. */
  readonly fileQueries?: FileQueryDeps;
  /** The extension and the switch of the application under test, and the summarizer its seams hold. */
  readonly extension?: ProfileExtension;
  readonly previewOn?: boolean;
  readonly caseSummarizer?: CaseSummarizer;
  /** The person the application answers for; a role or an id other than the local one. */
  readonly principal?: () => { readonly role?: 'administrator' | 'investigator' | 'viewer'; readonly id?: string };
}

/** The stable IDs a batched read was given, in order; the scripted source answers a row for each one it holds, with the position of the ID in the list. */
export const idsOf = (call: ExecuteCall): readonly string[] => {
  const refs = call.parameters['refs'];
  return Array.isArray(refs) ? refs.map((entry: { readonly stableId: string }) => entry.stableId) : [];
};

const json = { 'content-type': 'application/json' };
let sequence = 0;

export async function startExportRig(options: ExportRigOptions = {}) {
  const mapping = exportMapping({ ...(options.synthetic === undefined ? {} : { synthetic: options.synthetic }), ...(options.descriptions === undefined ? {} : { descriptions: options.descriptions }), ...(options.userConcurrency === undefined ? {} : { userConcurrency: options.userConcurrency }), ...(options.requestsPerMinute === undefined ? {} : { requestsPerMinute: options.requestsPerMinute }), ...(options.retention === undefined ? {} : { retention: options.retention }) });
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has a source');
  const known = (id: string): boolean => (typeof options.widgets === 'function' ? options.widgets(id) : (options.widgets ?? ['W-1', 'W-2']).includes(id));
  const executor = new TestExecutor(
    withSchema(
      () => schemaAnswer(onlineIndexesOf(source)),
      async (call): Promise<ExecuteOutcome> => {
        const custom = options.answer?.(call);
        if (custom !== undefined) return custom;
        if (call.templateId === 'entity-load') {
          const id = String(call.parameters['stableId']);
          if (known(id)) return { status: 'rows', rows: [{ n: widget(id, options.name?.(id) ?? 'Ana Silva') }] };
          return { status: 'rows', rows: [] };
        }
        const ids = idsOf(call);
        if (call.templateId === 'entity-load-many') {
          const refs = call.parameters['refs'];
          const entityType = String(call.parameters['entityType'] ?? (Array.isArray(refs) ? (refs[0] as { entityType?: string } | undefined)?.entityType : undefined));
          return { status: 'rows', rows: ids.flatMap((id, i) => (entityType === 'gadget' ? (id === 'GT-1' ? [{ i, dup: false, n: gadget() }] : []) : entityType === 'widget' && known(id) ? [{ i, dup: false, n: widget(id, options.name?.(id) ?? 'Ana Silva') }] : [])) };
        }
        if (call.templateId === 'edge-load-many') return { status: 'rows', rows: ids.flatMap((id, i) => ((options.links ?? []).includes(id) ? [{ i, dup: false, ...link(id) }] : [])) };
        return { status: 'rows', rows: [] };
      },
    ),
  );
  const events: AuditEvent[] = [];
  const stored: AuditSink = {
    record: (event) => {
      if (options.failAudit?.(event.action) === true) return Promise.reject(new Error('the sink is down'));
      events.push(event);
      return Promise.resolve();
    },
  };
  const queued = queuedAudit(stored);
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit' | 'privilegedAudit'> = {
    policy: { authorizeSource: () => Promise.resolve(options.deny?.() === true ? { allowed: false, reason: 'no' } : { allowed: true }) },
    coordinator: defaults.coordinator,
    audit: options.auditMember ?? (options.directAudit === true ? stored : queued.audit),
    privilegedAudit: stored,
  };
  const forbidExport = (items: readonly Record<string, unknown>[], context: Parameters<typeof redactItems>[1]) =>
    redactItems(
      items.map((item) => {
        const nodes = item['nodes'];
        return Array.isArray(nodes) ? { ...item, nodes: nodes.map((node: { ref: { stableId: string }; authorization: object }) => (node.ref.stableId === options.unexportableNode ? { ...node, authorization: { ...node.authorization, canExport: false } } : node)) } : item;
      }),
      context,
    );
  const redact = options.hideNode !== undefined ? hidingRedact(options.hideNode, redactItems) : options.unexportableNode !== undefined ? forbidExport : undefined;
  const parts = testSourceGate(mapping, { executor, seams, referenceKeys: TEST_REFERENCE_KEYS, ...(redact === undefined ? {} : { redact }), ...(options.fileQueries === undefined ? {} : { fileQueries: options.fileQueries }) });
  const directory = join(mkdtempSync(join(tmpdir(), 'nbx-export-rig-')), 'exports');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = createExportFileStore(directory);
  const store = memoryAppStore();
  if (options.principal !== undefined) {
    const original = store.current.bind(store);
    store.current = async () => {
      const identity = await original();
      const { role, id } = options.principal?.() ?? {};
      return { ...identity, principal: { ...identity.principal, ...(role === undefined ? {} : { role }), ...(id === undefined ? {} : { id }) } };
    };
  }
  const app = await buildApp({
    webRoot: exportWebRoot,
    logger: createLogger({ write: (line) => void options.logLines?.push(line) }),
    store,
    mapping,
    gate: parts.gate,
    seams: { ...defaults, ...seams, ...(options.caseSummarizer === undefined ? {} : { caseSummarizer: options.caseSummarizer }) },
    referenceKeys: TEST_REFERENCE_KEYS,
    exportFiles: files,
    ...(options.extension === undefined ? {} : { extension: options.extension, previewOn: options.previewOn ?? true }),
    ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
    ...(options.auditCounts === undefined ? {} : { auditCounts: options.auditCounts }),
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
