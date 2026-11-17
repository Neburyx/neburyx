import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

async function main(): Promise<void> {
  if (parentPort === null || !isRecord(workerData) || typeof workerData['module'] !== 'string' || typeof workerData['exportName'] !== 'string') throw new Error('the check worker was started without a check');
  const loaded: unknown = await import(workerData['module']);
  const check = isRecord(loaded) ? loaded[workerData['exportName']] : undefined;
  if (typeof check !== 'function') throw new Error('the check worker found no check');
  const started = performance.now();
  const value: unknown = check(workerData['input']);
  parentPort.postMessage({ value, ms: performance.now() - started });
}

await main();
