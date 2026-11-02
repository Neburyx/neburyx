import { afterEach, vi } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import type { SourceModel } from '../mapping/model.js';
import { baseSource, firstSource, load } from './mapping.js';
import { fakeDrivers, type FakeBehaviour } from './fake-source-driver.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';

export const NOW = 1_000_000;
export const ENV = { DEMO_USER: 'reader', DEMO_PASSWORD: 'a password value' };

export function sourceModel(overrides: Record<string, unknown> = {}): SourceModel {
  return firstSource(load(baseSource({ id: 'demo', database: 'graph-db', ...overrides })));
}

export function callFor(overrides: Partial<ExecuteCall> = {}): ExecuteCall {
  return {
    sourceId: 'demo',
    templateId: 'search',
    templateVersion: '1',
    cypher: 'MATCH (n) RETURN n',
    parameters: { text: 'x' },
    accessMode: 'READ',
    timeoutMs: 5000,
    rowLimit: 3,
    deadlineAt: NOW + 10_000,
    traceId: 'trace-1',
    ...overrides,
  };
}

export interface Rig {
  readonly executor: Neo4jExecutor;
  readonly fake: ReturnType<typeof fakeDrivers>;
  readonly logs: { readonly fields: Record<string, unknown>; readonly message: string }[];
  env: Record<string, string | undefined>;
}

const rigs: Rig[] = [];
export function rig(behaviour: FakeBehaviour = {}, sources: readonly SourceModel[] = [sourceModel()], env: Record<string, string | undefined> = { ...ENV }): Rig {
  const fake = fakeDrivers(behaviour);
  const logs: Rig['logs'] = [];
  const made: Rig = {
    fake,
    logs,
    env,
    executor: createNeo4jExecutor({
      sources,
      env,
      logger: { warn: (fields, message) => logs.push({ fields: { ...fields }, message }) },
      clock: () => Date.now(),
      createDriver: fake.factory,
    }),
  };
  rigs.push(made);
  return made;
}

afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
  await Promise.all(rigs.splice(0).map((made) => made.executor.close()));
});

export function useClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

