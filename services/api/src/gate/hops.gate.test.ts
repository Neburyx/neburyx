import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AuditEvent } from '../seams/seams.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, harness, testCatalog, testTemplate } from '../testing/gate.js';
import { firstSource } from '../testing/mapping.js';
import { budgetsFrom } from './assemble.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { hopCap, hopsSchema } from './hops.js';

const MAX = 2;
const hoppingTemplate = testTemplate({ id: 'hopping', paramsSchema: z.strictObject({ key: z.string(), hops: hopsSchema }), hops: { param: 'hops', max: MAX }, rows: 'one' });
const catalog = testCatalog([hoppingTemplate]);

function run(hops: unknown, maxHops = DEFAULT_BUDGETS.maxHops) {
  const events: AuditEvent[] = [];
  const { gate, executor } = harness({ catalog, budgetsFor: () => ({ ...DEFAULT_BUDGETS, maxHops }), seams: { audit: { record: (event) => Promise.resolve(void events.push(event)) } } });
  const outcome = gate.run(gateRequest({ templateId: 'hopping', params: { key: 'k1', hops } })).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { outcome, executor, events };
}

describe('the budgets of a source', () => {
  it('carry the max_hops of its mapping, 4 when it sets none', () => {
    expect(budgetsFrom(firstSource(mappingOf(sourceWith('alpha')))).maxHops).toBe(4);
    expect(budgetsFrom(firstSource(mappingOf(sourceWith('alpha', { budgets: { max_hops: 1 } })))).maxHops).toBe(1);
  });
});

describe('hopCap', () => {
  it.each([
    [2, 4, 2],
    [2, 1, 1],
    [2, 2, 2],
  ])('of a template maximum %i and a source max_hops %i is %i', (templateMax, sourceMax, cap) => {
    expect(hopCap(templateMax, { maxHops: sourceMax })).toBe(cap);
  });
});

describe('a template that names hops', () => {
  it('refuses a request for more hops than its maximum with QUERY_BUDGET_EXCEEDED carrying the cap, runs nothing and audits a refusal, and does not clip it', async () => {
    const { outcome, executor, events } = run(3);
    const error = await outcome;
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } });
    expect(executor.calls).toEqual([]);
    expect(events.map((event) => event.result)).toEqual(['refused']);
  });

  it('is capped by the source when its max_hops is lower', async () => {
    const refused = run(2, 1);
    expect(await refused.outcome).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 1 } });
    expect(refused.executor.calls).toEqual([]);
  });

  it.each([
    [1, 4],
    [2, 4],
    [1, 1],
    [2, 2],
  ])('runs a request for %i hops on a source with max_hops %i', async (hops, maxHops) => {
    const { outcome, executor } = run(hops, maxHops);
    expect(await outcome).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
  });

  it.each([0, 5, 2.5, -1, '2', null])('refuses %j with INVALID_REQUEST and no cap in the details', async (hops) => {
    const { outcome, executor } = run(hops);
    const error = await outcome;
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(error).not.toHaveProperty('details.maxHops');
    expect(executor.calls).toEqual([]);
  });
});

describe('a template that names no hops', () => {
  it('is read as before whatever the source max_hops', async () => {
    const { gate, executor } = harness({ budgetsFor: () => ({ ...DEFAULT_BUDGETS, maxHops: 1 }) });
    await gate.run(gateRequest());
    expect(executor.calls).toHaveLength(1);
  });
});

describe('the catalog and a hop declaration', () => {
  const problem = (overrides: Partial<TemplateDefinition>): string | undefined => {
    try {
      createTemplateCatalog({ templates: [{ ...hoppingTemplate, ...overrides }] });
      return undefined;
    } catch (error) {
      return error instanceof CatalogError ? error.message : 'not a CatalogError';
    }
  };

  it('accepts a declaration of an integer parameter and a maximum from 1 to 4', () => {
    expect(problem({})).toBeUndefined();
    expect(problem({ hops: { param: 'hops', max: 1 } })).toBeUndefined();
    expect(problem({ hops: { param: 'hops', max: 4 } })).toBeUndefined();
  });

  it('refuses a hop parameter that its schema does not have, or does not have as a whole number', () => {
    expect(problem({ hops: { param: 'missing', max: 2 } })).toBe('the template hopping declares a hop parameter its schema does not have as a whole number');
    expect(problem({ hops: { param: 'key', max: 2 } })).toContain('declares a hop parameter');
  });

  it.each([0, 5, 1.5, -2])('refuses a hop maximum of %j', (max) => {
    expect(problem({ hops: { param: 'hops', max } })).toBe('the template hopping declares a hop maximum outside 1 to 4');
  });
});

describe('a template whose schema drops the declared hop parameter', () => {
  it('is refused as a defect and runs nothing, so the bound can never be skipped', async () => {
    const dropping = testTemplate({ id: 'dropping', paramsSchema: z.strictObject({ key: z.string(), hops: hopsSchema }).transform(({ key }) => ({ key })), hops: { param: 'hops', max: MAX }, rows: 'one' });
    const { gate, executor } = harness({ catalog: testCatalog([dropping]) });
    const error = await gate.run(gateRequest({ templateId: 'dropping', params: { key: 'k1', hops: 1 } })).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(executor.calls).toEqual([]);
  });
});
