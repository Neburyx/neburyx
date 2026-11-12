import { SYSTEM_ACTOR_ID, tokenCount, type AuditEvent, type AuditSinkContext } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AuditSinkError, createAuditSink, type AuditPool } from './sink.js';

const SHA = 'a'.repeat(64);

const NEW_ID = '01939999-0000-7000-8000-000000000001';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

function rig(failure?: Error) {
  const calls: Call[] = [];
  const configs: Record<string, unknown>[] = [];
  const errors: (() => void)[] = [];
  let ended = 0;
  const pool: AuditPool = {
    query: (text, values) => (failure === undefined ? (calls.push({ text, values }), Promise.resolve()) : Promise.reject(failure)),
    end: () => (ended += 1, Promise.resolve()),
    on: (_event, listener) => void errors.push(listener),
  };
  const context: AuditSinkContext = {
    databaseUrl: 'postgres://app.example.test/neburyx',
    poolSize: 3,
    connectionTimeoutMs: 1111,
    statementTimeoutMs: 2222,
    queryTimeoutMs: 3333,
    newId: () => NEW_ID,
    onConnectionError: () => undefined,
  };
  const mounted = createAuditSink(context, { createPool: (config) => (configs.push({ ...config }), pool) });
  return { mounted, calls, configs, errors, ended: () => ended, context };
}

const EVENT: AuditEvent = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', action: 'graph.expand', result: 'success', traceId: 'tr-1' };

describe('the connection of the audit sink', () => {
  it('takes the database login, the pool size and the three timeouts from the context, and reports a connection error through it', () => {
    const { configs, errors, context } = rig();
    expect(configs).toEqual([{ connectionString: context.databaseUrl, max: 3, connectionTimeoutMillis: 1111, statement_timeout: 2222, query_timeout: 3333 }]);
    expect(errors).toEqual([context.onConnectionError]);
  });
});

describe('the connection stream of the audit sink', () => {
  it('is the stream of the pool when the context has one, and no stream key when it has none', () => {
    const configs: Record<string, unknown>[] = [];
    const pool: AuditPool = { query: () => Promise.resolve(), end: () => Promise.resolve(), on: () => undefined };
    const base: AuditSinkContext = { databaseUrl: 'postgres://app.example.test/neburyx', poolSize: 1, connectionTimeoutMs: 1, statementTimeoutMs: 1, queryTimeoutMs: 1, newId: () => NEW_ID, onConnectionError: () => undefined };
    const stream = (): never => {
      throw new Error('not called');
    };
    createAuditSink({ ...base, connectionStream: stream }, { createPool: (config) => (configs.push({ ...config }), pool) });
    createAuditSink(base, { createPool: (config) => (configs.push({ ...config }), pool) });
    expect(configs[0]?.['stream']).toBe(stream);
    expect(configs[1]).not.toHaveProperty('stream');
  });
});

describe('recording an event', () => {
  it('inserts one row with every member as sent, the id the context made, and the detail as JSON', async () => {
    const { mounted, calls } = rig();
    await mounted.sink.record({ ...EVENT, sourceId: 'src', investigationId: 'inv', resourceType: 'entity', resourceRef: 'person:1', detail: { counts: { nodes: 2, edges: 1, missing: 0 } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([NEW_ID, EVENT.actorId, 'investigator', 'graph.expand', 'success', 'src', 'inv', 'entity', 'person:1', 'tr-1', '{"counts":{"nodes":2,"edges":1,"missing":0}}']);
  });

  it('stores null for every optional member that is absent', async () => {
    const { mounted, calls } = rig();
    await mounted.sink.record(EVENT);
    expect(calls[0]?.values).toEqual([NEW_ID, EVENT.actorId, 'investigator', 'graph.expand', 'success', null, null, null, null, 'tr-1', null]);
  });

  it('stores the system actor under the system id, and a null role as the role system', async () => {
    const { mounted, calls } = rig();
    await mounted.sink.record({ ...EVENT, actorId: 'system', actorRole: 'system' });
    await mounted.sink.record({ ...EVENT, actorId: SYSTEM_ACTOR_ID, actorRole: null });
    expect(calls.map((call) => [call.values[1], call.values[2]])).toEqual([[SYSTEM_ACTOR_ID, 'system'], [SYSTEM_ACTOR_ID, 'system']]);
  });

  it('writes the AI fields of a model call as counts and codes', async () => {
    const { mounted, calls } = rig();
    await mounted.sink.record({ ...EVENT, action: 'ask.plan', detail: { ai: { modelRef: 'model-a', promptId: 'ask-plan', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(10), tokensOut: 'unknown' } } });
    expect(calls[0]?.values[10]).toBe('{"ai":{"modelRef":"model-a","promptId":"ask-plan","promptVersion":"1","promptSha256":"'+SHA+'","tokensIn":10,"tokensOut":"unknown"}}');
  });

  it('writes the prompt hash and the names of the pii properties, and refuses an event whose AI detail has no hash', async () => {
    const { mounted, calls } = rig();
    const ai = { modelRef: 'model-a', promptId: 'ask-plan', promptVersion: '1', promptSha256: SHA, piiPropertiesSent: ['person.phone'], tokensIn: tokenCount(1), tokensOut: 'unknown' } as const;
    await mounted.sink.record({ ...EVENT, action: 'ask.plan', detail: { ai } });
    expect(JSON.parse(String(calls[0]?.values[10]))).toEqual({ ai });
    const { promptSha256: _omitted, ...withoutHash } = ai;
    await expect(mounted.sink.record({ ...EVENT, detail: { ai: withoutHash } as never })).rejects.toMatchObject({ code: 'AUDIT_DETAIL_REFUSED' });
  });

  it.each([
    ['a prompt', { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'unknown', tokensOut: 'unknown', prompt: 'PROMPT-MARKER' } }],
    ['text', { text: 'SUMMARY-MARKER' }],
    ['a summary', { summary: 'SUMMARY-MARKER' }],
    ['an answer', { reason: 'timeout', answer: 'x' }],
    ['a negative count', { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: -1, tokensOut: 'unknown' } }],
    ['a decimal count', { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 1.5, tokensOut: 'unknown' } }],
    ['a label with a space', { ai: { modelRef: 'a prompt as a model', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'unknown', tokensOut: 'unknown' } }],
    ['a text count', { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'many', tokensOut: 'unknown' } }],
  ])('refuses a detail with %s, writes no row and says nothing of the value', async (_name, detail) => {
    const { mounted, calls } = rig();
    // the detail is ill-typed on purpose: the sink refuses what the type already forbids
    const refused = mounted.sink.record({ ...EVENT, detail: detail as never });
    await expect(refused).rejects.toBeInstanceOf(AuditSinkError);
    await expect(refused).rejects.toMatchObject({ code: 'AUDIT_DETAIL_REFUSED' });
    expect(calls).toEqual([]);
    expect(String(await refused.catch((error: unknown) => error))).not.toMatch(/MARKER|prompt|summary/);
  });

  it('rejects a failed write with a fixed code and none of the driver text, which can hold the row', async () => {
    const { mounted } = rig(new Error('duplicate key value violates ... Failing row contains (MARKER-ROW)'));
    const error = await mounted.sink.record(EVENT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error).toMatchObject({ code: 'AUDIT_WRITE_FAILED', message: 'the audit event could not be written' });
    expect(JSON.stringify(error) + String(error) + (error instanceof Error ? error.stack ?? '' : '')).not.toContain('MARKER-ROW');
    expect(error instanceof Error ? error.cause : 'not an error').toBeUndefined();
  });
});

describe('closing the sink', () => {
  it('ends the pool once however often it is called', async () => {
    const { mounted, ended } = rig();
    await mounted.close();
    await mounted.close();
    expect(ended()).toBe(1);
  });
});
