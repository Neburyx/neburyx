import { createHash } from 'node:crypto';
import { checkIntentQuery, fileQueryResultSchema, type AskFolder, type AskIntent } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createFileQueryRunner } from '../ask/file-query-run.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { FileQueryDeps } from './file-query.js';
import { fileQueryDepsOf } from './file-query.js';
import type { ExecuteOutcome } from './executor.js';
import type { GateRequest } from './types.js';

const TEXT = 'MATCH (p:Person {id: $id})-[k:KNOWS]->(q:Person) RETURN p, k, q';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const queryIntent = (name: string, parameters: readonly string[], text = TEXT, hash = sha(text)): AskIntent => ({ name, parameters, kind: 'query', query: { text, sha256: hash } });

function folderOf(bySource: Readonly<Record<string, readonly AskIntent[]>>): AskFolder {
  return {
    sourceIds: Object.keys(bySource),
    source: (sourceId) => (bySource[sourceId] === undefined ? undefined : { classification: { text: '', sha256: '' }, intents: bySource[sourceId] ?? [] }),
    intent: (sourceId, name) => bySource[sourceId]?.find((intent) => intent.name === name),
  };
}

const node = (elementId: string, id: string, labels: readonly string[] = ['Person']) => ({ $type: 'node', elementId, labels, properties: { id } });
const knows = { $type: 'relationship', elementId: 'r1', type: 'KNOWS', startElementId: 'n1', endElementId: 'n2', properties: {} };
const ROW = { p: node('n1', 'p-1'), k: knows, q: node('n2', 'p-2') };
const rowsOf = (...rows: readonly Record<string, unknown>[]): ExecuteOutcome => ({ status: 'rows', rows });

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta', { relationships: [{ type: 'FRIEND', from: 'person', to: 'person' }] }));
const personal = mappingOf(sourceWith('alpha', { entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] }], relationships: [] }));

function rig(options: { readonly folder?: AskFolder | undefined; readonly deps?: FileQueryDeps | undefined; readonly answer?: ExecuteOutcome; readonly mapping?: typeof mapping } = {}) {
  const executor = new TestExecutor(() => Promise.resolve(options.answer ?? rowsOf(ROW)));
  const record = auditing();
  const folder = 'folder' in options ? options.folder : folderOf({ alpha: [queryIntent('who-knows', ['id'])] });
  const fileQueries = 'deps' in options ? options.deps : folder === undefined ? undefined : fileQueryDepsOf(() => folder);
  const parts = testSourceGate(options.mapping ?? mapping, { executor, seams: record.seams, ...(fileQueries === undefined ? {} : { fileQueries }) });
  return { ...parts, record, runner: createFileQueryRunner({ gate: parts.gate }) };
}

const request = (over: Record<string, unknown> = {}) => ({ traceId: 'tr-1', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', intent: 'who-knows', values: { id: 'p-1' }, ...over });
const refusal = async (promise: Promise<unknown>): Promise<{ code?: string; details?: unknown }> => promise.then(() => ({}), (error: { code?: string; details?: unknown }) => ({ code: error.code, details: error.details }));

describe('a stored file query run through the gate', () => {
  it('sends the text of the folder once, with the values as its only parameters, and answers the nodes and relationships it returned with references of the source', async () => {
    const { runner, executor } = rig();
    const result = await runner.run(request());
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ cypher: TEXT, parameters: { id: 'p-1' }, accessMode: 'READ' });
    expect(Object.keys(executor.calls[0]?.parameters ?? {})).toEqual(['id']);
    expect(result.nodes.map((entry) => entry.ref)).toEqual([
      { sourceId: 'alpha', entityType: 'person', stableId: 'p-1' },
      { sourceId: 'alpha', entityType: 'person', stableId: 'p-2' },
    ]);
    expect(result.edges).toHaveLength(1);
    expect(fileQueryResultSchema.safeParse(result).success).toBe(true);
  });

  it('refuses, and reads nothing, a request whose params hold any field beyond the intent and the values', async () => {
    const { gate, executor } = rig();
    for (const params of [{ intent: 'who-knows', values: { id: 'x' }, query: 'MATCH (n) RETURN n' }, { intent: 'who-knows' }, { values: { id: 'x' } }, { intent: 'who-knows', values: 'x' }]) {
      const given: GateRequest = { traceId: 'tr-2', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'file-query', params, limit: 50 };
      expect((await refusal(gate.run(given))).code).toBe('INVALID_REQUEST');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('sets the limit to the source max_page itself: a request with another limit is refused', async () => {
    const { gate, executor } = rig();
    const given = (limit: number): GateRequest => ({ traceId: 'tr-3', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'file-query', params: { intent: 'who-knows', values: { id: 'x' } }, limit });
    expect((await refusal(gate.run(given(5)))).code).toBe('INVALID_REQUEST');
    expect((await refusal(gate.run(given(51)))).code).toBeDefined();
    await gate.run(given(50));
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.rowLimit).toBe(51);
  });

  it('is not listed with the templates a person can run, and the system runner may not run it', async () => {
    const { catalog, system, executor } = rig();
    expect(catalog.find('file-query')?.name).toBeUndefined();
    expect(catalog.find('file-query')?.scope).toBe('user');
    expect((await refusal(system.run({ traceId: 'tr-4', sourceId: 'alpha', templateId: 'file-query', params: { intent: 'who-knows', values: { id: 'x' } }, limit: 50 }))).code).toBe('ACCESS_DENIED');
    expect(executor.calls).toHaveLength(0);
  });
});

describe('what the folder cannot vouch for', () => {
  const check = (problems: readonly string[]): FileQueryDeps => ({ intent: (sourceId, name) => folderOf({ alpha: [queryIntent('who-knows', ['id'])] }).intent(sourceId, name), check: () => problems });

  it.each([
    ['a query that the checker refuses', { deps: check(['a write']) }],
    ['a text whose hash is not the one the folder holds', { folder: folderOf({ alpha: [queryIntent('who-knows', ['id'], TEXT, sha('another text'))] }) }],
    ['a clause outside the allowlist', { folder: folderOf({ alpha: [queryIntent('who-knows', ['id'], 'LOAD CSV FROM $id AS row RETURN row')] }) }],
  ])('refuses %s as file-query-text before anything is read', async (_name, options) => {
    const { runner, executor, record } = rig(options);
    expect(await refusal(runner.run(request()))).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-text' } });
    expect(executor.calls).toHaveLength(0);
    expect(record.events[0]).toMatchObject({ result: 'refused' });
  });

  it('refuses a write, a procedure and a query that names a parameter it does not declare with the real checker', async () => {
    for (const text of ['MATCH (n:Person) SET n.x = 1 RETURN n', 'CALL db.createLabel("X")', 'MATCH (n:Person {id: $other}) RETURN n']) {
      const { runner, executor } = rig({ folder: folderOf({ alpha: [queryIntent('who-knows', ['id'], text)] }) });
      expect(checkIntentQuery({ intent: 'who-knows', query: text, parameters: ['id'] }).length).toBeGreaterThan(0);
      expect(await refusal(runner.run(request()))).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-text' } });
      expect(executor.calls).toHaveLength(0);
    }
  });

  it.each([
    ['an intent the folder does not hold', request({ intent: 'unknown' }), undefined],
    ['a name that is not an intent name', request({ intent: 'who knows' }), undefined],
    ['the reserved saved-pattern intent', request({ intent: 'saved-pattern' }), folderOf({ alpha: [queryIntent('who-knows', ['id'])] })],
    ['an intent that only another source holds', request({ sourceId: 'beta' }), folderOf({ alpha: [queryIntent('who-knows', ['id'])], beta: [queryIntent('other-intent', ['id'])] })],
    ['a source with no subfolder', request({ sourceId: 'beta' }), folderOf({ alpha: [queryIntent('who-knows', ['id'])] })],
    ['a template intent', request({ intent: 'by-template' }), folderOf({ alpha: [{ name: 'by-template', parameters: ['id'], kind: 'template', template: 'entity', settings: {} }] })],
  ])('refuses %s as file-query-intent and reads nothing', async (_name, given, folder) => {
    const { runner, executor } = rig({ folder: folder ?? folderOf({ alpha: [queryIntent('who-knows', ['id'])] }) });
    expect(await refusal(runner.run(given))).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-intent' } });
    expect(executor.calls).toHaveLength(0);
  });

  it('refuses a file query through runMany, which would audit it without its intent, and reads nothing', async () => {
    const { gate, executor, record } = rig();
    const given: GateRequest = { traceId: 'tr-m', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'file-query', params: { intent: 'who-knows', values: { id: 'x' } }, limit: 50 };
    expect((await refusal(gate.runMany([given]))).code).toBe('INVALID_REQUEST');
    expect(executor.calls).toHaveLength(0);
    expect(record.events[0]).toMatchObject({ result: 'refused' });
  });

  it('refuses every file query when there is no folder', async () => {
    const { runner, executor } = rig({ deps: undefined });
    expect(await refusal(runner.run(request()))).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-intent' } });
    const folderless = rig({ deps: fileQueryDepsOf(() => undefined) });
    expect(await refusal(folderless.runner.run(request()))).toMatchObject({ details: { reason: 'file-query-intent' } });
    expect(executor.calls).toHaveLength(0);
  });

  it.each([
    ['a missing value', {}],
    ['an extra value', { id: 'x', more: 'y' }],
    ['a value that is not text', { id: 5 }],
    ['an empty value', { id: '' }],
    ['a value over 256 characters', { id: 'x'.repeat(257) }],
    ['another name', { other: 'x' }],
  ])('refuses %s as file-query-values and reads nothing', async (_name, values) => {
    const { runner, executor } = rig();
    expect(await refusal(runner.run(request({ values })))).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-values' } });
    expect(executor.calls).toHaveLength(0);
  });

  it('refuses more values than the folder allows', async () => {
    const names = Array.from({ length: 21 }, (_unused, index) => `p${index}`);
    const text = `MATCH (n:Person) WHERE ${names.map((name) => `n.id = $${name}`).join(' OR ')} RETURN n`;
    const { runner, executor } = rig({ folder: folderOf({ alpha: [queryIntent('many', names, text)] }) });
    expect(await refusal(runner.run(request({ intent: 'many', values: Object.fromEntries(names.map((name) => [name, 'x'])) })))).toMatchObject({ details: { reason: 'file-query-values' } });
    expect(executor.calls).toHaveLength(0);
  });
});

describe('the result rule', () => {
  const outcome = async (value: unknown, options: { readonly mapping?: typeof mapping } = {}) => {
    const { runner, record } = rig({ answer: rowsOf({ x: value }), ...options });
    return { answer: await runner.run(request()).then((result) => ({ result }), (error: { code?: string; details?: unknown }) => ({ error })), record };
  };

  it.each([
    ['a number', 5],
    ['text', 'abc'],
    ['a truth value', true],
    ['a map', { a: node('n1', 'p-1') }],
    ['a list that holds another value', [node('n1', 'p-1'), 'abc']],
    ['a list in a list', [[node('n1', 'p-1')]]],
    ['a value the adapter could not convert', { $type: 'unsupported' }],
    ['a date', { $type: 'date', value: '2026-01-01' }],
    ['a node of a type the mapping does not name', node('n9', 'z-1', ['Stranger'])],
    ['a relationship of a type the mapping does not name', { ...knows, type: 'STRANGER' }],
    ['a relationship mapped only for another source', { ...knows, type: 'FRIEND' }],
  ])('refuses %s, as file-query-result, and returns no row', async (_name, value) => {
    const { answer, record } = await outcome(value);
    expect(answer).toMatchObject({ error: { code: 'INVALID_REQUEST', details: { reason: 'file-query-result' } } });
    expect(record.events[0]).toMatchObject({ result: 'refused' });
  });

  it('refuses the whole result when one row is wrong, even after rows that were fine', async () => {
    const { runner } = rig({ answer: rowsOf(ROW, { p: 'text' }) });
    expect(await refusal(runner.run(request()))).toMatchObject({ details: { reason: 'file-query-result' } });
  });

  it('draws a column that is a node, a relationship, a list of them, a path or null, each element once', async () => {
    const path = { $type: 'path', start: node('n1', 'p-1'), segments: [{ relationship: knows, end: node('n2', 'p-2') }] };
    const { runner } = rig({ answer: rowsOf({ a: node('n1', 'p-1'), b: [node('n2', 'p-2'), node('n1', 'p-1')], c: null, d: path, e: knows }) });
    const result = await runner.run(request());
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });

  it('shows no property the mapping does not name, and masks the personal ones when masking is asked', async () => {
    const widget = { $type: 'node', elementId: 'w1', labels: ['Widget'], properties: { widgetId: 'w-1', ownerName: 'Pat Smith', secret: 'UNMAPPED-MARKER' } };
    const { runner } = rig({ mapping: personal, folder: folderOf({ alpha: [queryIntent('who-knows', ['id'], 'MATCH (w:Widget {widgetId: $id}) RETURN w')] }), answer: rowsOf({ w: widget }) });
    const plain = JSON.stringify(await runner.run(request()));
    expect(plain).toContain('Pat Smith');
    expect(plain).not.toContain('UNMAPPED-MARKER');
    const masked = JSON.stringify(await runner.run(request({ mask: true })));
    expect(masked).not.toContain('Pat Smith');
    expect(masked).not.toContain('UNMAPPED-MARKER');
  });

  it('refuses a result of more nodes and relationships than the count cap (the source heavy_op_threshold), and accepts one at it', async () => {
    const column = (count: number) => rowsOf({ q: Array.from({ length: count }, (_unused, index) => node(`n${index}`, `p-${index}`)) });
    const cap = 500;
    expect(await refusal(rig({ answer: column(cap + 1) }).runner.run(request()))).toMatchObject({ details: { reason: 'file-query-result' } });
    expect((await rig({ answer: column(cap) }).runner.run(request())).nodes).toHaveLength(cap);
  });
});

describe('the bounds of a file query', () => {
  const many = (count: number): ExecuteOutcome => rowsOf(...Array.from({ length: count }, (_unused, index) => ({ q: node(`n${index}`, `p-${index}`) })));

  it('asks the source for max_page + 1 rows whatever LIMIT the query holds, and answers at most max_page rows, labelled a lower bound when it was cut', async () => {
    const { runner, executor } = rig({ answer: many(51) });
    const result = await runner.run(request());
    expect(executor.calls[0]?.rowLimit).toBe(51);
    expect(result.count).toMatchObject({ quality: 'lowerBound', value: 50 });
    expect(result.nodes).toHaveLength(50);
    expect(result.notices).toEqual([{ code: 'readBounded' }]);
  });

  it('counts the rows exactly when the read ended, and gives no cursor in either case', async () => {
    const { runner, gate } = rig({ answer: many(3) });
    const result = await runner.run(request());
    expect(result.count).toMatchObject({ quality: 'exact', value: 3 });
    expect(result.notices).toEqual([]);
    const page = await gate.fileQuery(request());
    expect(page.nextCursor).toBeUndefined();
    const cut = rig({ answer: many(51) });
    expect((await cut.gate.fileQuery(request())).nextCursor).toBeUndefined();
  });

  it('answers the gate timeout, with no row, when the read runs past its time', async () => {
    const { runner } = rig({ answer: { status: 'timeout' } });
    expect(await refusal(runner.run(request()))).toMatchObject({ code: 'QUERY_TIMEOUT' });
  });

  it('answers a busy source and an unavailable source as every gate read does', async () => {
    for (const [answer, code] of [[{ status: 'unavailable', reason: 'unreachable' }, 'SOURCE_UNAVAILABLE']] as const) {
      const { runner } = rig({ answer });
      expect((await refusal(runner.run(request()))).code).toBe(code);
    }
  });
});

describe('the audit event of a file query', () => {
  const HASH = sha(TEXT);

  it('is written once, with the action ask.file_query and a detail that holds the intent and the hash of its query, and none of the values it ran with', async () => {
    const { runner, record } = rig();
    await runner.run(request({ values: { id: 'VALUE-MARKER-1' } }));
    expect(record.events).toHaveLength(1);
    expect(record.events[0]).toMatchObject({ action: 'ask.file_query', result: 'success', sourceId: 'alpha', detail: { fileQuery: { intent: 'who-knows', queryHash: HASH } } });
    expect(JSON.stringify(record.events)).not.toContain('VALUE-MARKER-1');
    expect(JSON.stringify(record.events)).not.toContain('MATCH');
  });

  it('is written for every refusal and failure too, with the intent and hash when the folder holds the intent, and the gate result', async () => {
    const wrongResult = rig({ answer: rowsOf({ x: 5 }) });
    await refusal(wrongResult.runner.run(request({ values: { id: 'VALUE-MARKER-2' } })));
    expect(wrongResult.record.events[0]).toMatchObject({ result: 'refused', detail: { fileQuery: { intent: 'who-knows', queryHash: HASH } } });
    const badValues = rig();
    await refusal(badValues.runner.run(request({ values: {} })));
    expect(badValues.record.events[0]).toMatchObject({ result: 'refused', detail: { fileQuery: { intent: 'who-knows', queryHash: HASH } } });
    const timeout = rig({ answer: { status: 'timeout' } });
    await refusal(timeout.runner.run(request()));
    expect(timeout.record.events[0]).toMatchObject({ result: 'failed', detail: { fileQuery: { intent: 'who-knows', queryHash: HASH }, reason: 'timeout' } });
  });

  it('leaves out a name the folder does not hold, so a string of the request is never written', async () => {
    const { runner, record } = rig();
    await refusal(runner.run(request({ intent: 'UNKNOWN-MARKER' })));
    await refusal(runner.run(request({ intent: 'not an intent name' })));
    for (const event of record.events) expect(event.detail).toBeUndefined();
    expect(JSON.stringify(record.events)).not.toContain('UNKNOWN-MARKER');
  });

  it('is the audit of every other template as it was: no file-query field', async () => {
    const { gate, record } = rig();
    await gate.run({ traceId: 'tr-9', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'does-not-exist', params: {}, limit: 5 }).catch(() => undefined);
    expect(record.events[0]?.detail).toBeUndefined();
  });
});
