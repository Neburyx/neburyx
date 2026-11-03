import { createStore, readable, type ReadableStore } from './store.js';

export interface JobOperation {
  readonly id: string;
  readonly phase: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly cancelRequested: boolean;
}

export interface JobState {
  readonly operations: ReadonlyMap<string, JobOperation>;
}

export function createJobStore(): ReadableStore<JobState> {
  return readable(createStore<JobState>({ operations: new Map() }));
}
