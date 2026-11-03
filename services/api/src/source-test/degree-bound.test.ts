import { describe, expect, it, vi } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { fakeDrivers } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { ENV, useClock } from '../testing/source-rig.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { createSourceTester } from './tester.js';

const mapping = mappingOf(sourceWith('alpha', { auth: { kind: 'basic', username_env: 'DEMO_USER', password_env: 'DEMO_PASSWORD' } }));
const [source] = mapping.sources;

function rig(degree: { hang?: boolean }) {
  useClock();
  const fake = fakeDrivers({ rows: [SERVER_ROW], degree });
  const logger = { warn: () => undefined };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: ENV, logger, createDriver: fake.factory });
  const defaults = communitySeams();
  const parts = assembleGate({ usability: ALWAYS_USABLE, mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger });
  const tester = createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() });
  return { fake, tester, executor };
}

const degreeSessions = (fake: ReturnType<typeof fakeDrivers>) => (fake.drivers[0]?.sessions ?? []).filter((session) => session.queries.some((query) => query.cypher.startsWith('PROFILE ')));

describe('a degree probe through the real executor', () => {
  it('begins its transaction with the timeout of the source, bounded by the gate deadline', async () => {
    const { fake, tester, executor } = rig({});
    await tester.run({ traceId: 'tr', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' });
    const sessions = degreeSessions(fake);
    expect(sessions).toHaveLength(3);
    expect(source?.budgets.timeoutMs).toBeGreaterThan(0);
    for (const session of sessions) expect(session.begins[0]?.timeout).toBe(Math.min(source?.budgets.timeoutMs ?? 0, 10_000));
    expect(fake.forbidden).toEqual([]);
    await executor.close();
  });

  it('ends as timeout at the gate deadline when the stream never completes, and the pairs left are not started', async () => {
    const { fake, tester, executor } = rig({ hang: true });
    const running = tester.run({ traceId: 'tr', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' });
    await vi.advanceTimersByTimeAsync(10_001);
    const report = await running;
    expect(degreeSessions(fake)).toHaveLength(1);
    expect(report.degreeChecks.types).toMatchObject([{ entityType: 'person', result: 'could-not-tell', basis: 'timeout' }, { entityType: 'order_line', result: 'could-not-tell', basis: 'skipped' }]);
    await executor.close();
  });
});
