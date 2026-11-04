import { createContext, useContext, type ReactNode } from 'react';
import { useStoreSelector } from '../state/store.js';
import { IDLE, type TestRun, type TestRuns } from './test-runs.js';

const TestRunsContext = createContext<TestRuns | undefined>(undefined);

export function TestRunsProvider({ runs, children }: { readonly runs: TestRuns; readonly children: ReactNode }) {
  return <TestRunsContext.Provider value={runs}>{children}</TestRunsContext.Provider>;
}

function useRuns(): TestRuns {
  const runs = useContext(TestRunsContext);
  if (runs === undefined) throw new Error('the test runs are not provided');
  return runs;
}

export function useTestRun(sourceId: string): TestRun {
  return useStoreSelector(useRuns(), (state) => state.get(sourceId) ?? IDLE);
}

export function useStartTest(): (sourceId: string) => void {
  return useRuns().start;
}
