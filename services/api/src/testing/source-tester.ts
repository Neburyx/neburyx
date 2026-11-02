import type { MappingModel } from '../mapping/model.js';
import { createSourceTester, type SourceTester } from '../source-test/tester.js';
import { memoryAppStore, type MemoryAppStore } from './app-store.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { PRIVILEGES_ID } from '../gate/templates/privileges.js';
import { SCHEMA_INDEXES_ID } from '../gate/templates/schema-indexes.js';
import { SCHEMA_TOKENS_ID } from '../gate/templates/schema-tokens.js';
import { STABLE_ID_DUPLICATES_ID } from '../gate/templates/stable-id-duplicates.js';
import { fittingIndexes, fittingTokens, NO_DUPLICATES } from './fitting-schema.js';
import { TestExecutor } from './gate.js';
import { testSourceGate } from './source-gate.js';

export const SERVER_ROW = { name: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };

type Answer = ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome>);

/** The answers of a source whose schema fits its mapping, for the three schema reads; a test gives its own to change one. */
export function fittingSchemaAnswer(call: ExecuteCall): ExecuteOutcome {
  if (call.templateId === SCHEMA_TOKENS_ID) return { status: 'rows', rows: [fittingTokens(call.parameters)] };
  if (call.templateId === SCHEMA_INDEXES_ID) return { status: 'rows', rows: [fittingIndexes(call.parameters)] };
  if (call.templateId === STABLE_ID_DUPLICATES_ID) return { status: 'rows', rows: [NO_DUPLICATES] };
  return { status: 'rows', rows: [] };
}

/**
 * An executor that answers the capabilities read with the given outcome, the privileges read as a Community server does (it refuses the administration command)
 * and the schema reads as a source whose schema fits its mapping; `privileges` and `schema` replace those answers.
 */
export function serverExecutor(
  capabilities: Answer = { status: 'rows', rows: [SERVER_ROW] },
  privileges: Answer = { status: 'unavailable', reason: 'refused' },
  schema: Answer = fittingSchemaAnswer,
): TestExecutor {
  return new TestExecutor((call) => {
    const isSchema = call.templateId === SCHEMA_TOKENS_ID || call.templateId === SCHEMA_INDEXES_ID || call.templateId === STABLE_ID_DUPLICATES_ID;
    const answer = call.templateId === PRIVILEGES_ID ? privileges : isSchema ? schema : capabilities;
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
