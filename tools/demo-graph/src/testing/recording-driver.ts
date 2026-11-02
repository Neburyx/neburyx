import type { LoaderDriverFactory, LoaderSettings } from '../load.js';

export interface Recording {
  readonly statements: { readonly cypher: string; readonly parameters: Record<string, unknown> | undefined }[];
  readonly transactionTimeouts: number[];
  readonly stored: { nodes: Record<string, number>; relationships: Record<string, number> };
  settings: LoaderSettings | undefined;
  drivers: number;
  sessionsClosed: number;
  driversClosed: number;
  connectivityChecks: number;
  commits: number;
  rollbacks: number;
}

export interface RecordingOptions {
  readonly existingNodes?: number;
  readonly failWhen?: (cypher: string) => Error | undefined;
  readonly unreachable?: Error;
  readonly storedOffset?: Readonly<Record<string, number>>;
}

export function serverError(code: string, message = 'a driver message that must not be repeated'): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export function recordingDriver(options: RecordingOptions = {}): { readonly factory: LoaderDriverFactory; readonly recording: Recording } {
  const recording: Recording = {
    statements: [],
    transactionTimeouts: [],
    stored: { nodes: {}, relationships: {} },
    settings: undefined,
    drivers: 0,
    sessionsClosed: 0,
    driversClosed: 0,
    connectivityChecks: 0,
    commits: 0,
    rollbacks: 0,
  };
  let existing = options.existingNodes ?? 0;
  const factory: LoaderDriverFactory = (settings) => {
    recording.drivers += 1;
    recording.settings = settings;
    return {
      verifyConnectivity: () => {
        recording.connectivityChecks += 1;
        return options.unreachable === undefined ? Promise.resolve({}) : Promise.reject(options.unreachable);
      },
      close: () => {
        recording.driversClosed += 1;
        return Promise.resolve();
      },
      session: () => ({
        close: () => {
          recording.sessionsClosed += 1;
          return Promise.resolve();
        },
        beginTransaction: (config) => {
          recording.transactionTimeouts.push(config.timeout);
          return Promise.resolve({
            commit: () => {
              recording.commits += 1;
              return Promise.resolve();
            },
            rollback: () => {
              recording.rollbacks += 1;
              return Promise.resolve();
            },
            run: (cypher, parameters) => {
              recording.statements.push({ cypher, parameters });
              const failure = options.failWhen?.(cypher);
              if (failure !== undefined) return Promise.reject(failure);
              const answer = (key: string, value: number) => Promise.resolve({ records: [{ get: (name: string) => (name === key ? value : undefined) }] });
              if (cypher.includes('RETURN count(n) AS nodes')) return answer('nodes', existing);
              if (cypher.includes('AS deleted')) {
                const deleted = existing;
                existing = 0;
                return answer('deleted', deleted);
              }
              const rows = Array.isArray(parameters?.['rows']) ? parameters['rows'].length : 0;
              const created = /CREATE \(n:`([^`]+)`\)/.exec(cypher)?.[1];
              if (created !== undefined) recording.stored.nodes[created] = (recording.stored.nodes[created] ?? 0) + rows;
              const connected = /CREATE \(a\)-\[r:`([^`]+)`\]->\(b\)/.exec(cypher)?.[1];
              if (connected !== undefined) recording.stored.relationships[connected] = (recording.stored.relationships[connected] ?? 0) + rows;
              const counted = /MATCH \(n:`([^`]+)`\) RETURN count\(n\) AS found/.exec(cypher)?.[1];
              if (counted !== undefined) return answer('found', (recording.stored.nodes[counted] ?? 0) + (options.storedOffset?.[counted] ?? 0));
              const countedEdges = /MATCH \(\)-\[r:`([^`]+)`\]->\(\) RETURN count\(r\) AS found/.exec(cypher)?.[1];
              if (countedEdges !== undefined) return answer('found', (recording.stored.relationships[countedEdges] ?? 0) + (options.storedOffset?.[countedEdges] ?? 0));
              return Promise.resolve({ records: [] });
            },
          });
        },
      }),
    };
  };
  return { factory, recording };
}
