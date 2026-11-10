import { aggregateEdgeDetailSchema, type AggregateEdgeRef } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID } from '../gate/templates/aggregate-evidence.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { parseMapping } from '../mapping/load.js';
import { withBreaker } from '../seams/breaker.js';
import { createReadSlots } from '../seams/read-slots.js';
import type { Coordinator } from '../seams/seams.js';
import { account, DERIVED_ENTITIES, device } from '../testing/derived-fixtures.js';
import { fakeClock, LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { communityAccess } from '../testing/source-access.js';
import { testSourceGate } from '../testing/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { createEdgeReader } from './edge-reader.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: [{ type: 'USES_TOOL', from: 'maker', to: 'tool', observed_at: 'seenAt' }] })), 'neburyx.yaml');
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const REF: AggregateEdgeRef = { sourceId: 'demo', aggregate: { type: 'USES_TOOL', from: { sourceId: 'demo', entityType: 'maker', stableId: 'A-1' }, to: { sourceId: 'demo', entityType: 'tool', stableId: 'D-1' } } };
const SAMPLE_OK: ExecuteOutcome = { status: 'rows', rows: [{ a: account('A-1'), b: device('D-1'), sample: [{ t: { $type: 'dateTime', value: '2026-01-01T00:00:00Z' } }] }] };
const SUMMARY_OK: ExecuteOutcome = { status: 'rows', rows: [{ members: 4, first: null, last: null }] };

function rig(answer: (call: ExecuteCall) => ExecuteOutcome, wrap?: (inner: Coordinator) => Coordinator) {
  const clock = fakeClock();
  const breaker = withBreaker(createReadSlots(), { clock: clock.now });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), (call) => Promise.resolve(answer(call))));
  const defaults = communitySeams();
  const parts = testSourceGate(mapping, { executor, clock: clock.now, seams: { policy: defaults.policy, audit: defaults.audit, coordinator: wrap === undefined ? breaker : wrap(breaker) } });
  const reader = createEdgeReader({ gate: parts.gate, mapping, access: communityAccess(mapping) });
  const read = () => reader.read({ traceId: 'tr-aggregate', principal: LOCAL_PRINCIPAL, ref: REF, mask: false });
  return { read, executor, clock };
}

const errorOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const byTemplate = (summary: ExecuteOutcome, sample: ExecuteOutcome = SAMPLE_OK) => (call: ExecuteCall): ExecuteOutcome => (call.templateId === AGGREGATE_SUMMARY_ID ? summary : call.templateId === AGGREGATE_SAMPLE_ID ? sample : { status: 'rows', rows: [] });
const FAILURES = DEFAULT_BUDGETS.breaker.failures;

describe('the failures of an aggregate read', () => {
  it('counts a summary read that timed out, though it is answered as an unknown count, toward the source\'s breaker, which then refuses the whole read as SOURCE_UNAVAILABLE', async () => {
    const run = rig(byTemplate({ status: 'timeout' }));
    for (let index = 0; index < FAILURES; index += 1) expect(aggregateEdgeDetailSchema.parse(await run.read()).members.quality).toBe('unknown');
    expect(await errorOf(run.read())).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts' });
    expect(run.executor.calls.filter((call) => call.templateId === AGGREGATE_SAMPLE_ID)).toHaveLength(FAILURES);
  });

  it('refuses the whole read as SOURCE_BUSY when the slots are full for the sample read, and reads no data', async () => {
    const run = rig(byTemplate(SUMMARY_OK), () => ({ acquireRead: () => Promise.resolve({ status: 'busy' as const }) }));
    expect(await errorOf(run.read())).toMatchObject({ code: 'SOURCE_BUSY' });
    expect(run.executor.calls.filter((call) => call.templateId === AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it('keeps the sample and shows an unknown count when only the summary read is refused as busy: each read takes its own slot', async () => {
    let sampled = (): boolean => false;
    const run = rig(byTemplate(SUMMARY_OK), (inner) => ({ acquireRead: (request) => (sampled() ? Promise.resolve({ status: 'busy' as const }) : inner.acquireRead(request)) }));
    sampled = () => run.executor.calls.some((call) => call.templateId === AGGREGATE_SAMPLE_ID);
    const detail = aggregateEdgeDetailSchema.parse(await run.read());
    expect(detail.members.quality).toBe('unknown');
    expect(detail.sample.rows).toHaveLength(1);
  });

  it('fails the whole read, with nothing partial, when the sample read finds the source down or is cancelled, and runs no summary read', async () => {
    const down = rig(byTemplate(SUMMARY_OK, { status: 'unavailable', reason: 'unreachable' }));
    expect(await errorOf(down.read())).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(down.executor.calls.filter((call) => call.templateId === AGGREGATE_SUMMARY_ID)).toHaveLength(0);
    const cancelled = rig(byTemplate(SUMMARY_OK, { status: 'cancelled' }));
    expect(await errorOf(cancelled.read())).toBeDefined();
    expect(cancelled.executor.calls.filter((call) => call.templateId === AGGREGATE_SUMMARY_ID)).toHaveLength(0);
  });

  it('fails the whole read when the summary read finds the source down or is cancelled', async () => {
    const down = rig(byTemplate({ status: 'unavailable', reason: 'unreachable' }));
    expect(await errorOf(down.read())).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    const cancelled = rig(byTemplate({ status: 'cancelled' }));
    expect(await errorOf(cancelled.read())).toBeDefined();
  });
});
