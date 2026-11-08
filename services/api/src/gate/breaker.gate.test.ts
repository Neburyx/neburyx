import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { withBreaker } from '../seams/breaker.js';
import { createReadSlots } from '../seams/read-slots.js';
import type { Coordinator, ReadAccessRequest } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { fakeClock, gateRequest, harness, rowsOf, SOURCE_A, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { rangeIndex, schemaAnswer } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { createTemplateCatalog } from './catalog.js';
import { CONNECTIVITY_ID, connectivityTemplate } from './templates/connectivity.js';
import type { ExecuteOutcome } from './executor.js';
import { normalizeModelOf } from './normalize/model.js';
import { ENTITY_LOAD_ID, entityLoadTemplate } from './templates/entity-load.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import type { Budgets } from './types.js';

const RULE = { failures: 3, windowMs: 60_000, cooldownMs: 30_000 };
const BUDGETS: Budgets = { ...DEFAULT_BUDGETS, breaker: RULE };
const TIMEOUT: ExecuteOutcome = { status: 'timeout' };

function rig(options: { readonly answers?: (call: number) => ExecuteOutcome; readonly budgets?: Budgets; readonly wrap?: (inner: Coordinator) => Coordinator } = {}) {
  const clock = fakeClock();
  const slots = createReadSlots();
  const breaker = withBreaker(slots, { clock: clock.now });
  let call = 0;
  const executor = new TestExecutor(() => Promise.resolve((options.answers ?? (() => rowsOf(1)))(call++)));
  const parts = harness({ executor, clock: clock.now, budgetsFor: () => options.budgets ?? BUDGETS, seams: { coordinator: options.wrap === undefined ? breaker : options.wrap(breaker) } });
  return { ...parts, clock, slots };
}

const run = (gate: { run: (request: ReturnType<typeof gateRequest>) => Promise<unknown> }) => gate.run(gateRequest());
const errorOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('repeated timeouts open the breaker', () => {
  it('refuses the next read as SOURCE_UNAVAILABLE with the reason and a wait, and the executor sees no call', async () => {
    const r = rig({ answers: () => TIMEOUT });
    for (let i = 0; i < 3; i += 1) await expect(run(r.gate)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    const refused = await errorOf(run(r.gate));
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', details: { retryAfterMs: 30_000 } });
    expect(r.executor.calls).toHaveLength(3);
    expect(r.slots.inspect().sources.size).toBe(0);
  });

  it('is not disabled by a long source timeout: a timeout of 9,000 ms under the 10,000 ms deadline counts', async () => {
    const r = rig({ answers: () => TIMEOUT, budgets: { ...BUDGETS, timeoutMs: 9000 } });
    for (let i = 0; i < 3; i += 1) await errorOf(run(r.gate));
    await expect(run(r.gate)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('does not count a timeout of a read that was given less than its chance, a cancelled read, a failure or a busy refusal', async () => {
    const late = rig({ answers: () => TIMEOUT, wrap: (inner) => ({ acquireRead: async (request) => { late.clock.advance(6000); return inner.acquireRead(request); } }) });
    for (let i = 0; i < 6; i += 1) await expect(run(late.gate)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    const failing = rig({ answers: () => ({ status: 'unavailable', reason: 'unreachable' }) });
    for (let i = 0; i < 6; i += 1) await expect(run(failing.gate)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(failing.executor.calls).toHaveLength(6);
    const busy = rig({ wrap: () => ({ acquireRead: () => Promise.resolve({ status: 'busy' as const }) }) });
    for (let i = 0; i < 6; i += 1) await expect(run(busy.gate)).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
    const cancelled = rig({ answers: () => ({ status: 'cancelled' }) });
    for (let i = 0; i < 6; i += 1) await errorOf(run(cancelled.gate));
    await errorOf(run(cancelled.gate));
    expect(cancelled.executor.calls).toHaveLength(7);
  });

  it('keeps other sources open', async () => {
    const r = rig({ answers: () => TIMEOUT });
    for (let i = 0; i < 3; i += 1) await errorOf(run(r.gate));
    await expect(r.gate.run(gateRequest({ sourceId: 'source-b' }))).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(SOURCE_A).not.toBe('source-b');
  });

  it('counts a run of two pages once: the first answers and the second times out', async () => {
    const r = rig({ answers: (call) => (call % 2 === 0 ? rowsOf(1) : TIMEOUT), budgets: { ...BUDGETS, breaker: { ...RULE, failures: 2 } } });
    await errorOf(r.gate.runMany([gateRequest(), gateRequest()]));
    await expect(run(r.gate)).resolves.toBeDefined();
    r.executor.calls.length = 0;
    const next = rig({ answers: () => TIMEOUT, budgets: { ...BUDGETS, breaker: { ...RULE, failures: 2 } } });
    await errorOf(next.gate.runMany([gateRequest(), gateRequest()]));
    await expect(run(next.gate)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
  });

  it('refuses a ping while open', async () => {
    const clock = fakeClock();
    const executor = new TestExecutor(() => Promise.resolve(TIMEOUT));
    const parts = harness({ executor, clock: clock.now, budgetsFor: () => BUDGETS, catalog: createTemplateCatalog({ templates: [connectivityTemplate] }), seams: { coordinator: withBreaker(createReadSlots(), { clock: clock.now }) } });
    const ping = { traceId: 't', sourceId: SOURCE_A, templateId: CONNECTIVITY_ID, params: {}, limit: 1 };
    for (let i = 0; i < 3; i += 1) await expect(parts.system.run(ping)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    await expect(parts.system.run(ping)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts' });
    expect(executor.calls).toHaveLength(3);
  });
});

describe('the trial read of a recovering source', () => {
  const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });

  it('lets an expand of a type with a stable ID through: its index read is not the trial, its data read is, and an answer closes the breaker', async () => {
    const clock = fakeClock();
    const roles: string[] = [];
    const breaker = withBreaker(createReadSlots(), { clock: clock.now });
    const coordinator: Coordinator = { acquireRead: (request: ReadAccessRequest) => (roles.push(request.role), breaker.acquireRead(request)) };
    let timingOut = true;
    const executor = new TestExecutor((call) => Promise.resolve(call.templateId === 'schema-indexes' ? schemaAnswer([rangeIndex('Widget', 'widgetId', 'ONLINE', true)]) : timingOut ? TIMEOUT : entityRows(WIDGET)));
    const parts = harness({
      catalog: createTemplateCatalog({ templates: [entityLoadTemplate, schemaIndexesTemplate] }),
      executor,
      clock: clock.now,
      budgetsFor: () => BUDGETS,
      modelFor: () => normalizeModelOf(source),
      allowlistFor: () => allowlistFromMapping(source),
      seams: { coordinator },
    });
    const load = () => parts.gate.run(gateRequest({ sourceId: source.id, templateId: ENTITY_LOAD_ID, params: { entityType: 'widget', stableId: 'W-1' }, limit: 1 }));
    for (let i = 0; i < 3; i += 1) await expect(load()).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    await expect(load()).rejects.toMatchObject({ reason: 'repeated-timeouts' });
    clock.advance(30_000);
    roles.length = 0;
    timingOut = false;
    await expect(load()).resolves.toBeDefined();
    expect(roles).toEqual(['index', 'data']);
    await expect(load()).resolves.toBeDefined();
  });
});
