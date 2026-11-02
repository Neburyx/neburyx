import type { MappingModel } from '../mapping/model.js';
import { createSourceTester, type SourceTester } from '../source-test/tester.js';
import { memoryAppStore, type MemoryAppStore } from './app-store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { PRIVILEGES_ID } from '../gate/templates/privileges.js';
import { TestExecutor } from './gate.js';
import { testSourceGate } from './source-gate.js';

export const SERVER_ROW = { name: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };

/**
 * An executor that answers the capabilities read with the given outcome and the privileges read as a Community server does (it refuses the administration command);
 * `privileges` replaces that answer, and `other` answers any other read.
 */
export function serverExecutor(
  capabilities: ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome>) = { status: 'rows', rows: [SERVER_ROW] },
  privileges: ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome>) = { status: 'unavailable', reason: 'refused' },
): TestExecutor {
  return new TestExecutor((call) => {
    const answer = call.templateId === PRIVILEGES_ID ? privileges : capabilities;
    return Promise.resolve(typeof answer === 'function' ? answer(call) : answer);
  });
}

/** A tester over a gate whose executor answers the capabilities read with one server row and refuses the privileges read. */
export function fakeSourceTester(
  mapping: MappingModel,
  executor = serverExecutor(),
  store: MemoryAppStore = memoryAppStore(),
) {
  const parts = testSourceGate(mapping, { executor });
  return { tester: createSourceTester({ gate: parts.gate, mapping, store, clock: () => Date.UTC(2026, 10, 2, 10, 0, 0) }) satisfies SourceTester, store, ...parts };
}
