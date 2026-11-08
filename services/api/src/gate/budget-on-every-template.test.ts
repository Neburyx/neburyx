import { describe, expect, it } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import { EMPTY_ALLOWLIST, LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { EMPTY_MODEL } from './normalize/model.js';
import { defaultCatalog, defaultCatalogTemplates } from './assemble.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { executeRead } from './execute.js';
import type { GateContext } from './types.js';

const BUDGET_MS = 3000;

const context = (system: boolean): GateContext => ({
  traceId: 'tr-budget',
  principal: LOCAL_PRINCIPAL,
  system,
  role: system ? 'background' : 'data',
  sourceId: 'alpha',
  budgets: { ...DEFAULT_BUDGETS, timeoutMs: BUDGET_MS },
  allowlist: EMPTY_ALLOWLIST,
  policyVersion: 'none',
  mask: false,
  model: EMPTY_MODEL,
  deadlineAt: Date.now() + 60_000,
});

describe('the execute stage, for every template in the catalog', () => {
  const templates = defaultCatalogTemplates();

  it('walks the catalog’s own list, so a template added later is covered without a row to write', () => {
    expect(templates.length).toBeGreaterThan(10);
  });

  it.each(templates.map((template) => [template.id, template] as const))('%s is read in a READ call under the source’s timeout', async (_id, definition) => {
    const template = defaultCatalog().find(definition.id);
    if (template === undefined) throw new Error('the template is not in the catalog');
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [] }));
    const seams = communitySeams();
    const deps = { coordinator: seams.coordinator, executor, clock: Date.now, logger: { warn: () => undefined } };
    await executeRead(deps, context(template.scope === 'system'), template, { cypher: template.cypher, parameters: {} }, 5);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ templateId: template.id, timeoutMs: BUDGET_MS, accessMode: 'READ' });
  });
});
