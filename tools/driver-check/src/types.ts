import type { CallEnd, CloseEnd, CloseReading, Sample, TimeoutReading } from './readings.js';

export type Reuse = { readonly ok: true } | { readonly ok: false; readonly what: string };

export interface ServerFacts {
  readonly image: string;
  readonly serverVersion: string;
  readonly edition: string;
  readonly driverVersion: string;
}

export interface TimeoutResult {
  readonly end: CallEnd;
  readonly samples: readonly Sample[];
  readonly reading: TimeoutReading;
  readonly sessionReuse: Reuse;
}

export interface QuickResult {
  readonly returned: boolean;
  readonly rows: number;
  readonly elapsedMs: number;
  readonly what?: string;
}

export interface CloseResult {
  readonly target: 'transaction' | 'session';
  readonly end: CallEnd;
  readonly closeEnd: CloseEnd;
  readonly samples: readonly Sample[];
  readonly reading: CloseReading;
  readonly driverReuse: Reuse;
}

export interface Findings {
  readonly facts: ServerFacts;
  readonly timeout: TimeoutResult;
  readonly quick: QuickResult;
  readonly closes: readonly CloseResult[];
  readonly cleanupFailures: readonly string[];
}
