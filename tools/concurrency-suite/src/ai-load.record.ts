import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RECORD_PATH = resolve(import.meta.dirname, '../../../docs/benchmarks/ai-runtime.json');

export interface Statistics {
  readonly medianMs: number;
  readonly p95Ms: number;
}

/** What the calibration run records and the acceptance test holds the code to. */
export interface AiRuntimeRecord {
  readonly workload: { readonly aiRequests: number; readonly readMsList: readonly number[]; readonly repetitions: number };
  readonly share: number;
  readonly alone: Statistics;
  readonly withAiRequests: Statistics;
  readonly withoutShare: Statistics;
  readonly margin: { readonly ratio: number };
  readonly offload: { readonly thresholdMs: number; readonly measuredP95Ms: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const numberAt = (value: unknown, key: string): number => {
  const found = isRecord(value) ? value[key] : undefined;
  if (typeof found !== 'number') throw new Error(`the record of the AI runtime has no number ${key}`);
  return found;
};
const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  const found = isRecord(value) ? value[key] : undefined;
  if (!isRecord(found)) throw new Error(`the record of the AI runtime has no object ${key}`);
  return found;
};
const statisticsAt = (value: unknown, key: string): Statistics => {
  const found = objectAt(value, key);
  return { medianMs: numberAt(found, 'medianMs'), p95Ms: numberAt(found, 'p95Ms') };
};

function parseRecord(text: string): AiRuntimeRecord {
  const parsed: unknown = JSON.parse(text);
  const workload = objectAt(parsed, 'workload');
  const readMsList = workload['readMsList'];
  if (!Array.isArray(readMsList) || !readMsList.every((entry): entry is number => typeof entry === 'number')) throw new Error('the record of the AI runtime has no list of read times');
  return {
    workload: { aiRequests: numberAt(workload, 'aiRequests'), readMsList, repetitions: numberAt(workload, 'repetitions') },
    share: numberAt(parsed, 'share'),
    alone: statisticsAt(parsed, 'alone'),
    withAiRequests: statisticsAt(parsed, 'withAiRequests'),
    withoutShare: statisticsAt(parsed, 'withoutShare'),
    margin: { ratio: numberAt(objectAt(parsed, 'margin'), 'ratio') },
    offload: { thresholdMs: numberAt(objectAt(parsed, 'offload'), 'thresholdMs'), measuredP95Ms: numberAt(objectAt(parsed, 'offload'), 'measuredP95Ms') },
  };
}

export const readRecord = (): AiRuntimeRecord => parseRecord(readFileSync(RECORD_PATH, 'utf8'));

/** The nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(1, Math.ceil(fraction * sorted.length)) - 1] ?? 0;
}

export const statisticsOf = (values: readonly number[]): Statistics => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });
