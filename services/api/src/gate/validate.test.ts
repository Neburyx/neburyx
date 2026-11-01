import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { AuditEvent, PolicyProvider } from '../seams/seams.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { gateRequest, harness, SOURCE_A, SOURCE_B, TEST_CYPHER, testCatalog, testTemplate } from '../testing/gate.js';

async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('a ref from another source', () => {
  it('is refused with SOURCE_MISMATCH before authorize, without an execute call, and audited as refused', async () => {
    const events: AuditEvent[] = [];
    let asked = 0;
    const policy: PolicyProvider = { authorizeSource: () => (asked++, Promise.resolve({ allowed: true })) };
    const { gate, executor } = harness({ seams: { policy, audit: { record: (event) => Promise.resolve(void events.push(event)) } } });
    const request = gateRequest({ params: { key: 'k1', ref: { sourceId: SOURCE_B, entityType: 'item', stableId: '1' } } });
    expect(await failureOf(gate.run(request))).toMatchObject({ code: 'SOURCE_MISMATCH' });
    expect(asked).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['refused']);
  });

  it('is accepted when the ref names the bound source', async () => {
    const { gate, executor } = harness();
    await gate.run(gateRequest({ params: { key: 'k1', ref: { sourceId: SOURCE_A, entityType: 'item', stableId: '1' } } }));
    expect(executor.calls).toHaveLength(1);
  });
});

describe('parameters that do not match the template schema', () => {
  it.each([
    ['a wrong type', { key: 5 }],
    ['a missing required field', {}],
    ['an unknown field', { key: 'k1', extra: 1 }],
    ['a value that is not an object', 'key=k1'],
  ])('gives INVALID_REQUEST and no executor call for %s', async (_name, params) => {
    const { gate, executor } = harness();
    const error = await failureOf(gate.run(gateRequest({ params })));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
  });
});

describe('a template that is not enabled for the source', () => {
  it('gives INVALID_REQUEST and no executor call, and is enabled for another source', async () => {
    const catalog = testCatalog([testTemplate()], new Set([`test-read@${SOURCE_A}`]));
    const { gate, executor } = harness({ catalog });
    expect(await failureOf(gate.run(gateRequest()))).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
    await gate.run(gateRequest({ sourceId: SOURCE_B }));
    expect(executor.calls).toHaveLength(1);
  });
});

describe('the limit', () => {
  it('above the source maximum gives QUERY_BUDGET_EXCEEDED carrying that maximum, with no executor call', async () => {
    const { gate, executor } = harness();
    const error = await failureOf(gate.run(gateRequest({ limit: DEFAULT_BUDGETS.maxPage + 1 })));
    expect(error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: DEFAULT_BUDGETS.maxPage } });
    expect(executor.calls).toEqual([]);
  });

  it('equal to the source maximum passes', async () => {
    const { gate, executor } = harness({ budgetsFor: () => ({ ...DEFAULT_BUDGETS, maxPage: 7 }) });
    await gate.run(gateRequest({ limit: 7 }));
    expect(executor.calls[0]?.rowLimit).toBe(8);
  });

  it.each([0, -1, 1.5, Number.NaN])('%s gives INVALID_REQUEST', async (limit) => {
    const { gate, executor } = harness();
    expect(await failureOf(gate.run(gateRequest({ limit })))).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
  });
});

describe('parameter text that looks like a query', () => {
  it('reaches the executor only as a parameter value, beside the template Cypher', async () => {
    const text = 'MATCH (n) DETACH DELETE n //';
    const { gate, executor } = harness();
    await gate.run(gateRequest({ params: { key: text } }));
    const call = executor.calls[0];
    expect(call?.cypher).toBe(TEST_CYPHER);
    expect(call?.cypher).not.toContain(text);
    expect(call?.parameters).toEqual({ key: text });
  });
});
