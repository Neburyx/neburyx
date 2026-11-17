import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { SCHEMA_DRAFT_CAP, SCHEMA_DRAFT_CONSTRAINTS_ID, SCHEMA_DRAFT_INDEXES_ID, SCHEMA_DRAFT_TOKENS_ID } from '../gate/templates/schema-draft.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { FAILURE_SENTENCES } from '../source-test/reasons.js';
import { communitySeams } from '../seams/community-seams.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { bareMapping } from './bare-source.js';
import { readSchema } from './schema-read.js';

const CONNECTION = { sourceId: 'own-source', uri: 'bolt://localhost:7687', database: 'neo4j', usernameEnv: 'NEO4J_USERNAME', passwordEnv: 'NEO4J_PASSWORD', connectWaitMs: 8000 };

const TOKENS = { labels: ['A', 'B', 'C'], labelsCut: false, types: ['R', 'S'], typesCut: false, propertyKeys: ['k1', 'k2', 'k3', 'k4'], propertyKeysCut: false };
const INDEXES = {
  indexes: [
    { name: 'i1', type: 'RANGE', entityType: 'NODE', labelsOrTypes: ['A'], properties: ['k1'], state: 'ONLINE' },
    { name: 'i2', type: 'TEXT', entityType: 'RELATIONSHIP', labelsOrTypes: ['R'], properties: ['k2'], state: 'ONLINE' },
  ],
  truncated: false,
};
const CONSTRAINTS = { constraints: [{ name: 'c1', type: 'UNIQUENESS', entityType: 'NODE', labelsOrTypes: ['A'], properties: ['k1'] }], truncated: false };

function answerOf(overrides: Partial<Record<string, ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome)>> = {}): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  const rows: Record<string, ExecuteOutcome> = {
    [SCHEMA_DRAFT_TOKENS_ID]: { status: 'rows', rows: [TOKENS] },
    [SCHEMA_DRAFT_INDEXES_ID]: { status: 'rows', rows: [INDEXES] },
    [SCHEMA_DRAFT_CONSTRAINTS_ID]: { status: 'rows', rows: [CONSTRAINTS] },
  };
  return (call) => {
    const chosen = overrides[call.templateId] ?? rows[call.templateId] ?? { status: 'rows', rows: [] };
    return Promise.resolve(typeof chosen === 'function' ? chosen(call) : chosen);
  };
}

function run(overrides: Parameters<typeof answerOf>[0] = {}) {
  const executor = new TestExecutor(answerOf(overrides));
  const parts = testSourceGate(bareMapping(CONNECTION), { executor });
  return { ...parts, executor, read: () => readSchema(parts.system, CONNECTION.sourceId, 'tr-init') };
}

describe('reading the schema of a source for a draft', () => {
  it('lists the labels, types, property keys, indexes and constraints, from the three fixed templates only', async () => {
    const { read, executor } = run();
    const answer = await read();
    expect(answer).toMatchObject({ ok: true, schema: { labels: ['A', 'B', 'C'], types: ['R', 'S'], propertyKeys: ['k1', 'k2', 'k3', 'k4'], labelsCut: false, typesCut: false, propertyKeysCut: false, indexesCut: false, constraintsCut: false } });
    if (!answer.ok) throw new Error('read failed');
    expect(answer.schema.indexes).toHaveLength(2);
    expect(answer.schema.indexes[1]).toMatchObject({ name: 'i2', type: 'TEXT', entityType: 'RELATIONSHIP', labelsOrTypes: ['R'], properties: ['k2'], state: 'ONLINE' });
    expect(answer.schema.constraints).toEqual(CONSTRAINTS.constraints);
    expect(executor.calls.map((call) => call.templateId)).toEqual([SCHEMA_DRAFT_TOKENS_ID, SCHEMA_DRAFT_INDEXES_ID, SCHEMA_DRAFT_CONSTRAINTS_ID]);
  });

  it('sends fixed statements with no parameter, no property value and no write, each bounded by one more than the cap', async () => {
    const { read, executor } = run();
    await read();
    for (const call of executor.calls) {
      expect(Object.keys(call.parameters), 'only the gate\'s own row limit is a parameter').toEqual(['limit']);
      expect(call.cypher).not.toMatch(/\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|LOAD|FOREACH)\b/i);
      expect(call.cypher).toContain(`LIMIT ${SCHEMA_DRAFT_CAP + 1}`);
      expect(call.cypher).toContain(`[..${SCHEMA_DRAFT_CAP}]`);
    }
    expect(executor.calls.every((call) => !/\bMATCH\b/i.test(call.cypher))).toBe(true);
  });

  it('runs every read through the gate, and the audit seam of the gate receives one event for each, with its action', async () => {
    const events: { action: string }[] = [];
    const stages: string[] = [];
    const executor = new TestExecutor(answerOf());
    const defaults = communitySeams();
    const parts = testSourceGate(bareMapping(CONNECTION), {
      executor,
      seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => { events.push(event); return Promise.resolve(); } } },
      observer: { stage: (stage, outcome) => void stages.push(`${stage}:${outcome}`) },
    });
    await readSchema(parts.system, CONNECTION.sourceId, 'tr-init');
    expect(events.map((event) => event.action)).toEqual(['source.schema_draft_tokens', 'source.schema_draft_indexes', 'source.schema_draft_constraints']);
    for (const stage of ['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit']) expect(stages.filter((entry) => entry === `${stage}:ok`)).toHaveLength(3);
  });

  it.each([
    ['labelsCut', { ...TOKENS, labelsCut: true }, SCHEMA_DRAFT_TOKENS_ID],
    ['typesCut', { ...TOKENS, typesCut: true }, SCHEMA_DRAFT_TOKENS_ID],
    ['propertyKeysCut', { ...TOKENS, propertyKeysCut: true }, SCHEMA_DRAFT_TOKENS_ID],
    ['indexesCut', { ...INDEXES, truncated: true }, SCHEMA_DRAFT_INDEXES_ID],
    ['constraintsCut', { ...CONSTRAINTS, truncated: true }, SCHEMA_DRAFT_CONSTRAINTS_ID],
  ])('says that one list was cut and leaves the others as they are (%s)', async (flag, row, templateId) => {
    const answer = await run({ [templateId]: { status: 'rows', rows: [row] } }).read();
    if (!answer.ok) throw new Error('read failed');
    const cuts = { labelsCut: answer.schema.labelsCut, typesCut: answer.schema.typesCut, propertyKeysCut: answer.schema.propertyKeysCut, indexesCut: answer.schema.indexesCut, constraintsCut: answer.schema.constraintsCut };
    expect(Object.entries(cuts).filter(([, value]) => value).map(([name]) => name)).toEqual([flag]);
  });

  it.each([
    ['unreachable', { status: 'unavailable', reason: 'unreachable' }],
    ['authentication', { status: 'unavailable', reason: 'authentication' }],
    ['credentials', { status: 'unavailable', reason: 'credentials' }],
    ['database', { status: 'unavailable', reason: 'database' }],
    ['refused', { status: 'unavailable', reason: 'refused' }],
  ] as const)('reports a read that fails as %s in the sentence test-source uses, with no partial schema', async (reason, outcome) => {
    const answer = await run({ [SCHEMA_DRAFT_INDEXES_ID]: outcome }).read();
    expect(answer).toEqual({ ok: false, message: FAILURE_SENTENCES[reason] });
  });

  it('reports a timeout in the sentence test-source uses', async () => {
    const answer = await run({ [SCHEMA_DRAFT_TOKENS_ID]: { status: 'timeout' } }).read();
    expect(answer).toEqual({ ok: false, message: FAILURE_SENTENCES.timeout });
  });

  it('reports an answer of an unusable shape as a failed read of that template', async () => {
    const answer = await run({ [SCHEMA_DRAFT_CONSTRAINTS_ID]: { status: 'rows', rows: [{ constraints: 'not a list' }] } }).read();
    expect(answer).toEqual({ ok: false, message: `The source's answer to the read ${SCHEMA_DRAFT_CONSTRAINTS_ID} could not be used.` });
    const none = await run({ [SCHEMA_DRAFT_TOKENS_ID]: { status: 'rows', rows: [] } }).read();
    expect(none.ok).toBe(false);
  });

  it('rethrows a failure that says nothing about the source', async () => {
    const { read } = run({ [SCHEMA_DRAFT_TOKENS_ID]: () => { throw new AppError('SOURCE_BUSY'); } });
    await expect(read()).rejects.toBeInstanceOf(AppError);
  });
});
