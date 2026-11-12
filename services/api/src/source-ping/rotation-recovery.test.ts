import { describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { createFirstContact } from '../source-test/first-contact.js';
import { observingStoreOf } from '../source-test/observing-store.js';
import { NOT_CHECKED_SINCE_START } from '../source-test/reasons.js';
import { createStartupChecker } from '../source-test/startup.js';
import { createUsabilityRecord } from '../source-test/usability.js';
import { memoryAppStore } from '../testing/app-store.js';
import { neo4jError, fakeDrivers } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createReachabilityCache, seedFromStartup } from './cache.js';
import { createPingOutcomeLog } from './outcome-log.js';
import { createScheduledPing, type PingResult } from './ping.js';
import { PING_INTERVAL_MS } from './schedule.js';
import { applyPingResults } from './state.js';

const mapping = mappingOf(sourceWith('alpha'));
const REFUSED_SIGN_IN = 'The source refused the sign-in.';
const refusal: ExecuteOutcome = { status: 'unavailable', reason: 'authentication' };

type Behaviour = (call: ExecuteCall) => ExecuteOutcome | undefined;

interface Line {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
}

/** The pieces of start.ts that decide a source's state, over a scripted source and the in-memory store, with the ticks driven by the test. */
function rig() {
  const store = memoryAppStore();
  const lines: Line[] = [];
  const logger = {
    info: (fields: object) => void lines.push({ level: 'info', fields: { ...fields } }),
    warn: (fields: object) => void lines.push({ level: 'warn', fields: { ...fields } }),
  };
  let now = Date.UTC(2026, 10, 12, 10, 0, 0);
  const clock = () => (now += 1000);
  let behaviour: Behaviour = () => undefined;
  const base = serverExecutor();
  const executor = new TestExecutor((call) => Promise.resolve(behaviour(call)).then((answer) => answer ?? base.execute(call)));
  const parts = testSourceGate(mapping, { executor });

  async function boot() {
    const record = createUsabilityRecord();
    const observing = observingStoreOf(store, record);
    await store.syncSources(mapping.sources);
    const results = await createStartupChecker({ system: parts.system, mapping, store: observing, logger, clock }).run();
    const cache = createReachabilityCache(['alpha']);
    seedFromStartup(cache, results);
    const ping = createScheduledPing({ system: parts.system, mapping, cache, clock });
    const contact = createFirstContact({ system: parts.system, mapping, store: observing, record, clock, logger, intervalMs: PING_INTERVAL_MS });
    const logOutcomes = createPingOutcomeLog(logger);
    return {
      contact,
      async tick(): Promise<readonly PingResult[]> {
        const ticked = await ping.run();
        logOutcomes(ticked);
        await applyPingResults(store, logger, ticked, { mapping });
        contact.afterTick(ticked);
        return ticked;
      },
    };
  }

  const shown = async () => {
    const [row] = await store.listSources();
    return { state: row?.state, reason: row?.stateReason };
  };
  return { store, lines, boot, shown, executor, behave: (next: Behaviour) => void (behaviour = next) };
}

const isPing = (call: ExecuteCall) => call.templateId === 'connectivity';
const CONNECTED = { state: 'connected', reason: null };
const UNAVAILABLE = { state: 'unavailable', reason: REFUSED_SIGN_IN };

describe('a source whose start-up check was refused after a credential change', () => {
  async function rotated() {
    const made = rig();
    const first = await made.boot();
    expect(await made.shown()).toEqual(CONNECTED);
    await first.contact.drain();
    made.behave(() => refusal);
    return made;
  }

  it('shows connected after the next ping that reaches it, and still after the one that follows', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    made.behave(() => undefined);
    await restarted.tick();
    expect(await made.shown()).toEqual(CONNECTED);
    await restarted.contact.drain();
    await restarted.tick();
    expect(await made.shown()).toEqual(CONNECTED);
  });

  it('shows the refusal of a first-contact check that follows a reaching ping until the next ping, which shows connected', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    let capabilities = 0;
    made.behave((call) => (call.templateId === 'capabilities' && (capabilities += 1) === 1 ? refusal : undefined));
    await restarted.tick();
    expect(await made.shown()).toEqual(CONNECTED);
    await restarted.contact.drain();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    await restarted.tick();
    expect(await made.shown()).toEqual(CONNECTED);
  });

  it('runs a further first-contact check on every tick while its check is refused and the pings reach the source, with no back-off', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    made.behave((call) => (isPing(call) ? undefined : refusal));
    const capabilityReads = () => made.executor.calls.filter((call) => call.templateId === 'capabilities').length;
    const before = capabilityReads();
    for (let tick = 0; tick < 3; tick += 1) {
      await restarted.tick();
      await restarted.contact.drain();
    }
    expect(capabilityReads() - before).toBe(3);
    expect(await made.shown()).toEqual(UNAVAILABLE);
  });

  it('keeps the start-up state while the pings are skipped, writes no state for them, and says so on the second skipped tick', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    made.behave((call) => (isPing(call) ? { status: 'unavailable', reason: 'pool-full' } : undefined));
    const written: string[] = [];
    const set = made.store.applyPingState.bind(made.store);
    made.store.applyPingState = (change) => (written.push(change.sourceId), set(change));
    for (let tick = 0; tick < 3; tick += 1) await restarted.tick();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    expect(written).toEqual([]);
    const skipped = made.lines.filter((line) => line.fields['event'] === 'source.ping_outcome');
    expect(skipped.map((line) => [line.level, line.fields['outcome'], line.fields['cause']])).toEqual([
      ['info', 'skipped', 'SOURCE_UNAVAILABLE:pool-full'],
      ['warn', 'skipped', 'SOURCE_UNAVAILABLE:pool-full'],
    ]);
  });

  it('shows connected after the second ping when the first was skipped, and the skipped tick wrote no state', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    let pings = 0;
    made.behave((call) => {
      if (isPing(call) && (pings += 1) === 1) return { status: 'unavailable', reason: 'pool-full' };
      return call.templateId === 'connectivity' || pings > 1 ? undefined : refusal;
    });
    expect((await restarted.tick())[0]?.skipped).toBe(true);
    expect(await made.shown()).toEqual(UNAVAILABLE);
    expect((await restarted.tick())[0]?.skipped).toBe(false);
    expect(await made.shown()).toEqual(CONNECTED);
  });

  it('is connected one ping after the refusals stop (scripted outcome)', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    await restarted.tick();
    await restarted.contact.drain();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    made.behave(() => undefined);
    await restarted.tick();
    expect(await made.shown()).toEqual(CONNECTED);
  });

  it('stays unavailable with the sign-in sentence while every ping is refused, and logs the outcome once', async () => {
    const made = await rotated();
    const restarted = await made.boot();
    for (let tick = 0; tick < 3; tick += 1) await restarted.tick();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    const outcomes = made.lines.filter((line) => line.fields['event'] === 'source.ping_outcome');
    expect(outcomes.map((line) => [line.level, line.fields['outcome'], line.fields['failure']])).toEqual([['warn', 'unreachable', 'authentication']]);
  });
});

describe('a source that no check ever reached', () => {
  it('shows the not-checked state, never connected, after the ping that reaches it and before its first-contact check ends', async () => {
    const made = rig();
    made.behave(() => refusal);
    const booted = await made.boot();
    expect(await made.shown()).toEqual(UNAVAILABLE);
    made.behave(() => undefined);
    await booted.tick();
    expect(await made.shown()).toEqual({ state: 'unknown', reason: NOT_CHECKED_SINCE_START });
  });
});

describe('the ping of a source whose start-up check was refused, over the real executor and read slots', () => {
  it('is not skipped on the first tick, so no slot or connection of the refused check is still held', async () => {
    const fake = fakeDrivers({ beginError: neo4jError('Neo.ClientError.Security.AuthenticationRateLimit') });
    const executor = createNeo4jExecutor({ sources: mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: { warn: () => undefined }, createDriver: fake.factory });
    const defaults = communitySeams();
    const parts = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined } });
    const results = await createStartupChecker({ system: parts.system, mapping, store: memoryAppStore(), logger: { info: () => undefined, warn: () => undefined } }).run();
    expect(results[0]).toMatchObject({ outcome: 'fail', answered: false });
    fake.behaviour = { rows: [SERVER_ROW] };
    const cache = createReachabilityCache(['alpha']);
    const [first] = await createScheduledPing({ system: parts.system, mapping, cache }).run();
    expect(first).toMatchObject({ skipped: false, current: 'reachable' });
    await executor.close();
  });

  it('is unreachable with the sign-in failure on each tick while the server answers with the failed-login lock, and reachable on the first tick after it stops', async () => {
    const fake = fakeDrivers({ beginError: neo4jError('Neo.ClientError.Security.AuthenticationRateLimit') });
    const executor = createNeo4jExecutor({ sources: mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: { warn: () => undefined }, createDriver: fake.factory });
    const defaults = communitySeams();
    const parts = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined } });
    const ping = createScheduledPing({ system: parts.system, mapping, cache: createReachabilityCache(['alpha']) });
    for (let tick = 0; tick < 3; tick += 1) expect((await ping.run())[0]).toMatchObject({ skipped: false, current: 'unreachable', failure: 'authentication' });
    fake.behaviour = { rows: [SERVER_ROW] };
    expect((await ping.run())[0]).toMatchObject({ skipped: false, current: 'reachable', failure: null });
    await executor.close();
  });
});
