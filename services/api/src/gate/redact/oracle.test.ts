import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { AuditEvent } from '../../seams/seams.js';
import { gateRequest, harness, rowsOf, testCatalog, testTemplate, TestExecutor } from '../../testing/gate.js';
import { packSource } from '../../testing/pack-fixtures.js';
import { normalizeModelOf } from '../normalize/model.js';

const source = packSource('banking-fraud');
const model = normalizeModelOf(source);
const withPii = source.entities.find((entity) => entity.pii.length > 0);
const [piiProperty] = withPii?.pii ?? [];
const plainProperty = withPii?.filterable[0] ?? withPii?.stableId ?? '';

const searching = testTemplate({
  id: 'search-by',
  paramsSchema: z.strictObject({ property: z.string() }),
  usedProperties: (params) => [{ entityType: withPii?.type ?? '', property: String(params['property']) }],
});
const unrelated = testTemplate({ id: 'no-properties', paramsSchema: z.strictObject({}) });

function rig() {
  const audit: AuditEvent[] = [];
  const parts = harness({
    catalog: testCatalog([searching, unrelated]),
    modelFor: () => model,
    executor: new TestExecutor((call) => Promise.resolve(rowsOf(call.rowLimit - 1))),
    seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } },
  });
  return { ...parts, audit };
}

const run = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

describe('a masked field is not an oracle', () => {
  it('has a pii property and a plain property to try', () => {
    expect(piiProperty).toBeDefined();
    expect(model.entitiesByType.get(withPii?.type ?? '')?.pii).toContain(piiProperty);
    expect(model.entitiesByType.get(withPii?.type ?? '')?.pii).not.toContain(plainProperty);
  });

  it('refuses a request that asks for masking and searches, filters or sorts by a pii property, before any read, and records it as refused', async () => {
    const { gate, executor, audit } = rig();
    expect(await run(gate.run(gateRequest({ templateId: 'search-by', params: { property: piiProperty }, mask: true })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ result: 'refused' });
  });

  it('runs the same request when it does not ask for masking', async () => {
    const { gate, executor } = rig();
    expect(await run(gate.run(gateRequest({ templateId: 'search-by', params: { property: piiProperty } })))).toBe('ok');
    expect(await run(gate.run(gateRequest({ templateId: 'search-by', params: { property: piiProperty }, mask: false })))).toBe('ok');
    expect(executor.calls).toHaveLength(2);
  });

  it('runs a request that asks for masking and uses only properties that are not pii', async () => {
    const { gate, executor } = rig();
    expect(await run(gate.run(gateRequest({ templateId: 'search-by', params: { property: plainProperty }, mask: true })))).toBe('ok');
    expect(executor.calls).toHaveLength(1);
  });

  it('finds nothing to refuse in a template that names no properties', async () => {
    const { gate } = rig();
    expect(await run(gate.run(gateRequest({ templateId: 'no-properties', params: {}, mask: true })))).toBe('ok');
  });

  it('does not refuse a property of an entity type the model does not know', async () => {
    const { gate } = harness({
      catalog: testCatalog([testTemplate({ id: 'search-by', paramsSchema: z.strictObject({}), usedProperties: () => [{ entityType: 'unknown-type', property: String(piiProperty) }] })]),
      modelFor: () => model,
    });
    expect(await run(gate.run(gateRequest({ templateId: 'search-by', params: {}, mask: true })))).toBe('ok');
  });
});
