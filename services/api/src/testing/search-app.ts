import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import { buildApp } from '../app.js';
import type { AssembleOptions } from '../gate/assemble.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { MappingModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import type { SourceUsability } from '../source-test/usability.js';
import { memoryAppStore } from './app-store.js';
import { entityRows, plainNode } from './entity-fixtures.js';
import { TestExecutor } from './gate.js';
import { withOnlineIndexes } from './search-fixtures.js';
import { baseSource, fileOf } from './mapping.js';
import { testSourceGate } from './source-gate.js';
import { makeWebRoot } from './web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

export const SEARCH_ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName'], pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId'] },
];

export const RELATED_ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName'], reference: ['batchRef', 'ownerRef'], pii: [{ property: 'ownerName', class: 'name' }, { property: 'ownerRef', class: 'text' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId'], reference: ['widgetRef'] },
  { type: 'part', label: 'Part', stable_id: 'partId', search: ['partId'] },
];

/** A mapping of the source `demo`, with the entity types of `SEARCH_ENTITIES` unless the overrides give others. */
export const searchMappingOf = (overrides: Record<string, unknown> = {}): MappingModel =>
  parseMapping(fileOf(baseSource({ id: 'demo', entities: SEARCH_ENTITIES, relationships: [], ...overrides })), 'neburyx.yaml');

export const widget = (index: number, extra: Record<string, unknown> = {}) => plainNode(['Widget'], { widgetId: `W-${String(index).padStart(3, '0')}`, ...extra }, `4:s:${index}`);
export const widgets = (count: number) => Array.from({ length: count }, (_, index) => widget(index + 1));

/** An executor that answers every read with the first rows that fit the row limit. */
export function answering(rows: readonly Record<string, unknown>[]): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => Promise.resolve(entityRows(...rows.slice(0, call.rowLimit)));
}

export interface SearchAppOptions {
  readonly rows?: readonly Record<string, unknown>[];
  readonly mapping?: MappingModel;
  readonly respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  /** True when `respond` answers the schema read itself; otherwise every index of the mapping is online. */
  readonly ownSchema?: boolean;
  readonly policy?: Seams['policy'];
  readonly coordinator?: Seams['coordinator'];
  readonly audit?: Seams['audit'];
  readonly usability?: SourceUsability;
  readonly redact?: AssembleOptions['redact'];
  readonly catalog?: AssembleOptions['catalog'];
}

export async function startSearchApp(options: SearchAppOptions = {}) {
  const mapping = options.mapping ?? searchMappingOf();
  const first = mapping.sources[0];
  if (first === undefined) throw new Error('the mapping has no source');
  const data = options.respond ?? answering(options.rows ?? [widget(1)]);
  const executor = new TestExecutor(options.ownSchema === true ? data : withOnlineIndexes(first, data));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const lines: string[] = [];
  const seams = { policy: options.policy ?? defaults.policy, coordinator: options.coordinator ?? defaults.coordinator, audit: options.audit ?? { record: (event: AuditEvent) => Promise.resolve(void events.push(event)) } };
  const parts = testSourceGate(mapping, {
    executor,
    seams,
    ...(options.usability === undefined ? {} : { usability: options.usability }),
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  const store = memoryAppStore();
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void lines.push(line) }), store, mapping, seams: { ...defaults, ...seams }, gate: parts.gate, indexes: parts.indexes });
  return { app, executor, events, lines, gate: parts.gate, mapping, store };
}

export type SearchApp = Awaited<ReturnType<typeof startSearchApp>>;

export const postSearch = (app: SearchApp['app'], payload: unknown) =>
  app.inject({ method: 'POST', url: '/v1/search/entities', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

export const searchCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'entity-search');
export const relatedCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'entity-related');
