import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';

export function plainNode(labels: readonly string[], properties: Readonly<Record<string, unknown>>, elementId = '4:fixture:1'): Record<string, unknown> {
  return { $type: 'node', elementId, labels, properties };
}

export function entityRows(...nodes: readonly Record<string, unknown>[]): ExecuteOutcome {
  return { status: 'rows', rows: nodes.map((node) => ({ n: node })) };
}

export function entityCalls(calls: readonly ExecuteCall[]): readonly ExecuteCall[] {
  return calls.filter((call) => call.templateId === 'entity-load');
}
