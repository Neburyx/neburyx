import { rmSync } from 'node:fs';
import { edgeRefSegmentOf } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { account, device, pathOf, DERIVED_ENTITIES, DERIVED_RULE } from '../testing/derived-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { tokensOf } from '../testing/fuzz-closed-set.js';
import { FUZZ_SOURCE, respond, startFuzzRig } from '../testing/fuzz-rig.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';

/**
 * The evidence fields a person reads to answer "can I trust this relationship?", pinned for each form of relationship: the fields of the answer, at every level, and the values the fixture source puts in
 * them. Taking one out, renaming one or adding one fails here, so the web and the contract cannot drift from the server unseen.
 */
type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };

/** The fields of a JSON value at every level, with the type of each leaf; an array has the shape of its first member. */
export function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, shapeOf(entry)]));
  return typeof value;
}

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, '4:fields:w1');
const gadget = plainNode(['Gadget'], { gadgetId: 'GD-1' }, '4:fields:g1');
const row = { r: plainRelationship('MADE_FROM', widget, gadget, { linkId: 'L-1', recordId: 'R-1' }, '5:fields:l1'), a: widget, b: gadget };
const rig = await startFuzzRig({ respond: (call) => (call.templateId === 'edge-load' ? Promise.resolve({ status: 'rows', rows: [row] }) : respond(call)) });
const entity = (stableId: string) => ({ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId });
const read = async (ref: Parameters<typeof edgeRefSegmentOf>[0]) => (await rig.app.inject({ method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(ref)}` })).json<Record<string, unknown>>();

const END = { ref: { sourceId: 'string', entityType: 'string', stableId: 'string' }, title: 'string', type: 'string' };
const STORED_REF = { sourceId: 'string', type: 'string', from: 'string', to: 'string', stableId: 'string' };

const STORED_SHAPE: Shape = {
  evidence: { records: [{ linkable: 'boolean', sourceRecordId: 'string' }], status: 'string' },
  from: END,
  properties: [{ dataClass: 'string', key: 'string', masked: 'boolean', value: 'string' }],
  qualityFlags: [],
  ref: STORED_REF,
  semantics: 'string',
  to: END,
  type: 'string',
};

const SUPPORT_SHAPE: Shape = { evidence: { code: 'string', status: 'string' }, from: END, ref: STORED_REF, to: END, type: 'string' };
const DERIVED_SHAPE: Shape = {
  from: END,
  qualityFlags: [],
  ref: { derived: { from: { entityType: 'string', sourceId: 'string', stableId: 'string' }, ruleId: 'string', to: { entityType: 'string', sourceId: 'string', stableId: 'string' } }, sourceId: 'string' },
  rule: { id: 'string', version: 'number' },
  semantics: 'string',
  supports: { count: { quality: 'string', scope: 'string', value: 'number' }, groups: [{ middle: [END], supports: [SUPPORT_SHAPE] }] },
  to: END,
  type: 'string',
  warnings: [],
};

describe('the evidence fields of a stored relationship', () => {
  it('are the status, and for each record its source record ID and whether it can be opened', async () => {
    const body = await read({ sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' });
    expect(shapeOf(body)).toEqual(sorted(STORED_SHAPE));
    expect(body['evidence']).toEqual({ status: 'available', records: [{ sourceRecordId: 'R-1', linkable: true }] });
    expect(body['semantics']).toBe('stored');
  });
});

describe('the evidence fields of a derived relationship', () => {
  it('are the rule with its version, the count of supports with its quality, and per group the middle entities and the supports with their own evidence', async () => {
    const body = await read({ sourceId: FUZZ_SOURCE, derived: { ruleId: 'shared-gadget', from: entity('W-1'), to: entity('W-2') } });
    expect(shapeOf(body)).toEqual(sorted(DERIVED_SHAPE));
    expect(body['semantics']).toBe('derived');
    expect(body['rule']).toEqual({ id: 'shared-gadget', version: 1 });
    expect(body['supports']).toMatchObject({ count: { value: 3, quality: 'exact', scope: 'derived:supports' } });
    const groups = (body['supports'] as { groups: { middle: unknown[]; supports: { evidence: unknown }[] }[] }).groups;
    expect(groups).toHaveLength(3);
    expect(groups[0]?.supports[0]?.evidence).toEqual({ status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' });
  });
});

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

/** A source whose USES_TOOL carries a record (`recordId`) and whose PLAIN relationship carries none, to pin the two forms the fuzz source does not give. */
const recorded = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: DERIVED_ENTITIES,
      relationships: [
        { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', evidence: ['recordId'], evidence_link: 'https://records.shape.test/{recordId}' },
        { type: 'PLAIN', from: 'maker', to: 'tool', stable_id: 'plainId' },
      ],
      derived: [DERIVED_RULE],
    }),
  ),
  'neburyx.yaml',
);
const maker = account('A-1');
const tool = device('D-1');
const other = account('A-2');
const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
  if (call.templateId === 'edge-load') {
    const r = plainRelationship('PLAIN', maker, tool, { plainId: 'P-1' }, '5:shape:p1');
    return Promise.resolve({ status: 'rows', rows: [{ r, a: maker, b: tool }] });
  }
  const first = plainRelationship('USES_TOOL', maker, tool, { useId: 'U-1', recordId: 'RC-1' }, '5:shape:u1');
  const second = plainRelationship('USES_TOOL', other, tool, { useId: 'U-2', recordId: 'RC-2' }, '5:shape:u2');
  return Promise.resolve({ status: 'rows', rows: [pathOf(maker, [{ relationship: first, end: tool }, { relationship: second, end: other as never }])] });
};
const [recordedSource] = recorded.sources;
const recordedParts = testSourceGate(recorded, { executor: new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(recordedSource as never)), answer)) });
const recordedApp = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: recorded, gate: recordedParts.gate });
afterAll(() => recordedApp.close());
const readRecorded = async (ref: Parameters<typeof edgeRefSegmentOf>[0]) => (await recordedApp.inject({ method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(ref)}` })).json<Record<string, unknown>>();

describe('the evidence fields of a stored relationship that carries no record', () => {
  it('are a status and a code, and the answer is still a 200 with the ends and the time', async () => {
    const body = await readRecorded({ sourceId: 'demo', type: 'PLAIN', from: 'maker', to: 'tool', stableId: 'P-1' });
    expect(body['evidence']).toEqual({ status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' });
    expect(shapeOf(body['evidence'])).toEqual({ code: 'string', status: 'string' });
    expect(body['semantics']).toBe('stored');
  });
});

describe('the evidence fields of a support of a derived relationship that carries records', () => {
  it('are the status and, for each record, its source record ID and whether it can be opened', async () => {
    const body = await readRecorded({ sourceId: 'demo', derived: { ruleId: 'shared-tool', from: { sourceId: 'demo', entityType: 'maker', stableId: 'A-1' }, to: { sourceId: 'demo', entityType: 'maker', stableId: 'A-2' } } });
    const groups = (body['supports'] as { groups: { supports: { evidence: unknown }[] }[] }).groups;
    const evidence = groups.flatMap((group) => group.supports.map((support) => support.evidence));
    expect(evidence).toHaveLength(2);
    for (const each of evidence) expect(shapeOf(each)).toEqual({ records: [{ linkable: 'boolean', sourceRecordId: 'string' }], status: 'string' });
    expect(evidence.map((each) => (each as { records: { sourceRecordId: string }[] }).records[0]?.sourceRecordId).sort()).toEqual(['RC-1', 'RC-2']);
    expect(evidence[0]).toMatchObject({ status: 'available', records: [{ linkable: true }] });
  });
});

describe('the pin fails for what it is for', () => {
  it('tells a response with a field taken out, renamed or added from the pinned one', async () => {
    const body = await read({ sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' });
    const evidence = body['evidence'] as { status: string; records: { sourceRecordId: string; linkable: boolean }[] };
    const [record] = evidence.records;
    const variants: Record<string, unknown> = {
      'a record without its source record ID': { ...body, evidence: { ...evidence, records: [{ linkable: true }] } },
      'a record ID renamed': { ...body, evidence: { ...evidence, records: [{ recordId: record?.sourceRecordId, linkable: true }] } },
      'the status taken out': { ...body, evidence: { records: evidence.records } },
      'a field added to a record': { ...body, evidence: { ...evidence, records: [{ ...record, elementId: '5:fields:l1' }] } },
    };
    for (const [name, changed] of Object.entries(variants)) expect(shapeOf(changed), name).not.toEqual(sorted(STORED_SHAPE));
  });
});

/** The shape with its keys in the order `shapeOf` gives. */
function sorted(shape: Shape): Shape {
  if (typeof shape === 'string') return shape;
  if (Array.isArray(shape)) return shape.map(sorted);
  return Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sorted(entry)]));
}

/** The aggregate form: the count with its scope, the observed range, and the sample with the order used; no member has an ID, a reference or a record. */
describe('the evidence fields of an aggregate relationship', () => {
  it('are the member count with its quality and scope, the observed range, and the sample with its order and how many more', async () => {
    const expanded = await rig.app.inject({ method: 'POST', url: '/v1/graph/expand', payload: JSON.stringify({ sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['phone'], direction: 'out' }), headers: { 'content-type': 'application/json' } });
    const handle = tokensOf(expanded.json())[0];
    expect(handle).toBeDefined();
    const body = await read({ sourceId: FUZZ_SOURCE, aggregate: { type: 'USES', from: entity('W-1'), to: { sourceId: FUZZ_SOURCE, ...(handle as { entityType: string; stableId: string }) } } });
    expect(body['semantics']).toBe('aggregate');
    expect(Object.keys(body).sort()).toEqual(['from', 'members', 'observedFirst', 'observedLast', 'qualityFlags', 'ref', 'sample', 'semantics', 'to', 'type', 'warnings']);
    expect(shapeOf(body['members'])).toEqual({ quality: 'string', scope: 'string', value: 'number' });
    expect(body['members']).toEqual({ value: 3, quality: 'exact', scope: 'aggregate:members' });
    const sample = body['sample'] as { order: string; rows: unknown[]; more?: number };
    expect(Object.keys(sample).sort()).toEqual(['more', 'order', 'rows']);
    expect(typeof sample.order).toBe('string');
    expect(typeof sample.more).toBe('number');
    expect(sample.rows.length).toBeGreaterThan(0);
    for (const row of sample.rows) expect(Object.keys(row as object).sort()).toEqual(expect.arrayContaining(['properties']));
    for (const row of sample.rows) expect(Object.keys(row as object).sort().every((key) => ['observedAt', 'properties'].includes(key))).toBe(true);
  });
});
