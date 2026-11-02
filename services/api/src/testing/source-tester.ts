import type { MappingModel } from '../mapping/model.js';
import { createSourceTester, type SourceTester } from '../source-test/tester.js';
import { memoryAppStore, type MemoryAppStore } from './app-store.js';
import { TestExecutor } from './gate.js';
import { testSourceGate } from './source-gate.js';

export const SERVER_ROW = { name: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };

/** A tester over a gate whose executor answers every read with one server row. */
export function fakeSourceTester(
  mapping: MappingModel,
  executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [SERVER_ROW] })),
  store: MemoryAppStore = memoryAppStore(),
) {
  const parts = testSourceGate(mapping, { executor });
  return { tester: createSourceTester({ gate: parts.gate, mapping, store, clock: () => Date.UTC(2026, 10, 2, 10, 0, 0) }) satisfies SourceTester, store, ...parts };
}
