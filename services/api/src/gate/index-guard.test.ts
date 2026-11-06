import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { gateRequest, harness, LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { rangeIndex, schemaAnswer, textIndex, withSchema, type IndexRow } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { createTemplateCatalog } from './catalog.js';
import { normalizeModelOf } from './normalize/model.js';
import { ENTITY_LOAD_ID, entityLoadTemplate } from './templates/entity-load.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import { testTemplate } from '../testing/gate.js';
import type { ExecuteOutcome } from './executor.js';
import type { IndexSnapshot } from './types.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const ONLINE: readonly IndexRow[] = [rangeIndex('Widget', 'widgetId', 'ONLINE', true)];

function rig(indexes: () => ExecuteOutcome | Promise<ExecuteOutcome>) {
  const audit: AuditEvent[] = [];
  const answering = new TestExecutor((call) => (call.templateId === 'schema-indexes' ? Promise.resolve(indexes()) : Promise.resolve(entityRows(WIDGET))));
  const parts = harness({
    catalog: createTemplateCatalog({ templates: [entityLoadTemplate, schemaIndexesTemplate] }),
    executor: answering,
    modelFor: () => normalizeModelOf(source),
    allowlistFor: () => allowlistFromMapping(source),
    seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } },
  });
  return { ...parts, executor: answering, audit };
}

const load = (extra: Partial<Parameters<typeof gateRequest>[0]> = {}) => gateRequest({ sourceId: source.id, templateId: ENTITY_LOAD_ID, params: { entityType: 'widget', stableId: 'W-1' }, limit: 1, ...extra });
const ids = (parts: { readonly executor: TestExecutor }): string[] => parts.executor.calls.map((call) => call.templateId);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? `${error.code}:${error.reason ?? ''}` : 'not an AppError';
  }
}

describe('the index guard refuses a read whose index is not online, before any data read', () => {
  it.each([
    ['no index at all', []],
    ['an index that is still being built', [rangeIndex('Widget', 'widgetId', 'POPULATING')]],
    ['an index that has failed', [rangeIndex('Widget', 'widgetId', 'FAILED')]],
    ['a TEXT index, which cannot serve the stable ID as text or as an integer', [textIndex('Widget', 'widgetId')]],
    ['an index of another property', [rangeIndex('Widget', 'other')]],
    ['an index of another label', [rangeIndex('Gadget', 'widgetId')]],
  ])('refuses the entity read for %s with SOURCE_UNAVAILABLE and the reason index-unavailable, and no statement names the label', async (_name, entries) => {
    const parts = rig(() => schemaAnswer(entries));
    expect(await codeOf(parts.gate.run(load()))).toBe('SOURCE_UNAVAILABLE:index-unavailable');
    expect(ids(parts)).toEqual(['schema-indexes']);
    expect(parts.executor.calls.some((call) => call.cypher.includes('Widget'))).toBe(false);
    expect(parts.audit.map((event) => `${event.action} ${event.result}`)).toEqual(['source.schema_indexes success', 'entity.load refused']);
  });

  it('lets the read through, with one schema read and one data read, when the index is online (a RANGE index or a constraint)', async () => {
    for (const entries of [ONLINE, [rangeIndex('Widget', 'widgetId')]]) {
      const parts = rig(() => schemaAnswer(entries));
      expect(await codeOf(parts.gate.run(load()))).toBe('ok');
      expect(ids(parts)).toEqual(['schema-indexes', 'entity-load']);
    }
  });
});

describe('the index guard where it cannot say', () => {
  it('goes on to the data read, as it did without the guard, when the source refuses to list indexes: the one case it cannot protect', async () => {
    const parts = rig(() => ({ status: 'unavailable', reason: 'refused' }));
    expect(await codeOf(parts.gate.run(load()))).toBe('ok');
    expect(ids(parts)).toEqual(['schema-indexes', 'entity-load']);
    expect(await codeOf(parts.gate.run(load()))).toBe('ok');
    expect(ids(parts)).toEqual(['schema-indexes', 'entity-load', 'schema-indexes', 'entity-load']);
  });

  it.each([
    ['a schema read that times out', () => ({ status: 'timeout' }) as const, 'QUERY_TIMEOUT:'],
    ['a source that is down', () => ({ status: 'unavailable', reason: 'unreachable' }) as const, 'SOURCE_UNAVAILABLE:unreachable'],
    ['an answer that cannot be read', () => ({ status: 'rows', rows: [{ nothing: true }] }) as const, 'INTERNAL_ERROR:read-failed'],
    ['an answer that is truncated', () => schemaAnswer([], true), 'INTERNAL_ERROR:read-failed'],
  ])('answers %s with its error, and runs no data read', async (_name, answer, code) => {
    const parts = rig(answer);
    expect(await codeOf(parts.gate.run(load()))).toBe(code);
    expect(ids(parts)).toEqual(['schema-indexes']);
  });
});

describe('who gives the snapshot', () => {
  const given = (sourceId: string, entries: readonly IndexRow[]): IndexSnapshot => ({ sourceId, entries });

  it('uses the snapshot of the caller for the same source and reads the schema no more', async () => {
    const parts = rig(() => schemaAnswer([]));
    expect(await codeOf(parts.gate.run(load({ indexes: given(source.id, ONLINE) })))).toBe('ok');
    expect(ids(parts)).toEqual(['entity-load']);
    expect(await codeOf(parts.gate.run(load({ indexes: given(source.id, []) })))).toBe('SOURCE_UNAVAILABLE:index-unavailable');
    expect(ids(parts)).toEqual(['entity-load']);
  });

  it('does not use the snapshot of another source, and reads the schema', async () => {
    const parts = rig(() => schemaAnswer(ONLINE));
    expect(await codeOf(parts.gate.run(load({ indexes: given('another', []) })))).toBe('ok');
    expect(ids(parts)).toEqual(['schema-indexes', 'entity-load']);
  });

  it('reads no schema when the caller says it tried and could not say', async () => {
    const parts = rig(() => schemaAnswer([]));
    expect(await codeOf(parts.gate.run(load({ indexes: 'unverified' })))).toBe('ok');
    expect(ids(parts)).toEqual(['entity-load']);
  });
});

describe('a template that needs no index', () => {
  it('makes no schema read', async () => {
    const executor = new TestExecutor();
    const parts = harness({ catalog: createTemplateCatalog({ templates: [testTemplate()] }), executor });
    await parts.gate.run(gateRequest());
    expect(executor.calls.map((call) => call.templateId)).toEqual(['test-read']);
  });
});

describe('the reader of indexes', () => {
  const request = (principal = LOCAL_PRINCIPAL) => ({ traceId: 'tr-indexes', principal, sourceId: source.id });
  const readerRig = (options: Parameters<typeof harness>[0] = {}) => {
    const executor = new TestExecutor((call) => Promise.resolve(call.templateId === 'schema-indexes' ? schemaAnswer(ONLINE) : entityRows(WIDGET)));
    return { ...harness({ catalog: createTemplateCatalog({ templates: [entityLoadTemplate, schemaIndexesTemplate] }), executor, modelFor: () => normalizeModelOf(source), allowlistFor: () => allowlistFromMapping(source), ...options }), executor };
  };

  it('reads the schema once for a principal the policy allows on a usable source, and runs nothing else', async () => {
    const parts = readerRig();
    expect(await parts.indexes.read(request())).toEqual({ sourceId: source.id, entries: ONLINE });
    expect(parts.executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
  });

  it.each([
    ['a principal the policy refuses', { seams: { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'denied' }) } } }],
    ['a source that is not usable', { usability: { isUsable: () => false } }],
  ])('reads nothing for %s and says unverified, so the run that follows is refused by its own rules', async (_name, options) => {
    const parts = readerRig(options);
    expect(await parts.indexes.read(request())).toBe('unverified');
    expect(parts.executor.calls).toEqual([]);
  });
});

describe('a failure of the caller\'s schema read', () => {
  it('fails the run with that same error, after authorization, audited, with no statement at all', async () => {
    const parts = rig(() => schemaAnswer(ONLINE));
    const failure = new AppError('QUERY_TIMEOUT');
    expect(await codeOf(parts.gate.run(load({ indexes: { failure } })))).toBe('QUERY_TIMEOUT:');
    expect(ids(parts)).toEqual([]);
    expect(parts.audit.map((event) => event.result)).toEqual(['failed']);
  });
});
