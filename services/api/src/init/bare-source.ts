import { resolveBudgets } from '../mapping/budgets.js';
import { hashSource } from '../mapping/hash.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';

export interface Connection {
  readonly sourceId: string;
  readonly uri: string;
  readonly database: string;
  readonly usernameEnv: string;
  readonly passwordEnv: string;
  /** How long the first connection may take, in milliseconds. */
  readonly connectWaitMs: number;
}

/**
 * The wait for the first connection of the one source init reads: its own setting, separate from the mapping defaults (2,000 ms to wait for a connection and 5,000 ms to make one), which
 * a name that the resolver answers slowly can outlast: the driver counts the lookup of the name in the time to make a connection.
 */
export const DEFAULT_CONNECT_WAIT_MS = 8000;
/** The gate ends a read at its request deadline of 10,000 ms, so a longer wait could not be kept. */
export const MIN_CONNECT_WAIT_MS = 1000;
export const MAX_CONNECT_WAIT_MS = 9000;

/** A model of one source that names no entity type: the gate needs a source to read from, and the draft is what will name the entity types. The budgets are the mapping defaults. */
export function bareMapping(connection: Connection): MappingModel {
  const budgets = resolveBudgets(undefined);
  const model: Omit<SourceModel, 'configHash'> = {
    id: connection.sourceId,
    uri: connection.uri,
    database: connection.database,
    auth: { usernameEnv: connection.usernameEnv, passwordEnv: connection.passwordEnv },
    synthetic: false,
    budgets: { ...budgets, defaultPage: Math.min(budgets.defaultPage, budgets.maxPage), queueWaitMs: connection.connectWaitMs, timeoutMs: connection.connectWaitMs },
    vocabulary: {},
    entities: [],
    relationships: [],
    derived: [],
    presets: [],
    styleRules: [],
  };
  return { sources: [{ ...model, configHash: hashSource(model) }] };
}
