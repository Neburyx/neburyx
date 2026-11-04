import type { LastTest, SourceState } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { answeredData, type ShellData } from '../shell/shell-data.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { lastTestOfReport } from './health-facts.js';

export interface TestRun {
  readonly running: boolean;
  readonly failure?: ApiFailure;
  readonly held?: LastTest;
  readonly finishedState?: SourceState;
}

export const IDLE: TestRun = { running: false };

export type TestRunsState = ReadonlyMap<string, TestRun>;

export interface TestRuns extends ReadableStore<TestRunsState> {
  readonly start: (sourceId: string) => void;
}

/**
 * Runs and holds the tests of the sources, outside React, so a run goes on and keeps its answer when the person selects another source or leaves the page.
 * A report is held until the next sources answer, which the server made after storing the test and so replaces it.
 */
export function createTestRuns(client: ApiClient, shell: ReadableStore<ShellData>): TestRuns {
  const store = createStore<TestRunsState>(new Map());
  let seenAnswer = answeredData(shell.getState().sources);

  const update = (sourceId: string, change: (run: TestRun) => TestRun): void => {
    const next = new Map(store.getState());
    next.set(sourceId, change(next.get(sourceId) ?? IDLE));
    store.setState(next);
  };

  shell.subscribe(() => {
    const answer = answeredData(shell.getState().sources);
    if (answer === seenAnswer) return;
    seenAnswer = answer;
    const next = new Map<string, TestRun>();
    for (const [sourceId, run] of store.getState()) {
      const { held: _dropped, ...rest } = run;
      next.set(sourceId, rest);
    }
    store.setState(next);
  });

  const start = (sourceId: string): void => {
    if (store.getState().get(sourceId)?.running === true) return;
    update(sourceId, ({ failure: _failure, finishedState: _state, ...run }) => ({ ...run, running: true }));
    void client.testSource(sourceId).then(
      (result) => {
        if (result.ok) {
          update(sourceId, () => ({ held: lastTestOfReport(result.value), running: false, finishedState: result.value.state }));
          shell.getState().reloadSources();
        } else {
          update(sourceId, (run) => ({ ...run, running: false, failure: result.failure }));
        }
      },
      () => update(sourceId, (run) => ({ ...run, running: false, failure: { code: 'UNEXPECTED_FAILURE' } })),
    );
  };

  return { ...readable(store), start };
}
