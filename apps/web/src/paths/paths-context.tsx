import { createContext, useContext, type ReactNode } from 'react';
import type { FailureReporter } from '../api/failure-reporter.js';
import type { RequestTracker } from '../banner/request-tracker.js';

/** What the Paths panel needs of the app beyond the client: the failure reporter that puts a server failure on the banner. */
export interface PathsEnvironment {
  readonly report?: FailureReporter;
  /** Shows a search that runs long as the Running state of the banner and a cancelled one as the Cancelled state. */
  readonly tracker?: RequestTracker;
}

const PathsContext = createContext<PathsEnvironment>({});

export function PathsProvider({ environment, children }: { readonly environment: PathsEnvironment; readonly children: ReactNode }) {
  return <PathsContext.Provider value={environment}>{children}</PathsContext.Provider>;
}

export function usePathsEnvironment(): PathsEnvironment {
  return useContext(PathsContext);
}
