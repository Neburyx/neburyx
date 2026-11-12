import type { ConnectionCause } from '../database-errors.js';
import { CONNECTION_TIMEOUT_MS } from './pool.js';

export const CONNECT_TIMEOUT_KEY = 'NEBURYX_DATABASE_CONNECT_TIMEOUT_MS';
export const MIN_CONNECT_TIMEOUT_MS = 1000;
export const MAX_CONNECT_TIMEOUT_MS = 120_000;

/** The limit on opening one connection to the application database, the name lookup included. Absent or empty: the default. `undefined`: a value that is not a whole number of milliseconds in range. */
export function parseConnectTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return CONNECTION_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value);
  return milliseconds >= MIN_CONNECT_TIMEOUT_MS && milliseconds <= MAX_CONNECT_TIMEOUT_MS ? milliseconds : undefined;
}

/** What a command or the start says when the application database could not be reached; it names the setting and never a value from the connection string. */
export function unreachableMessage(cause: ConnectionCause | undefined): string {
  if (cause === 'lookup') return 'the database could not be reached: the database name did not resolve';
  if (cause === 'limit') return `the database could not be reached: the name lookup or the connection took longer than ${CONNECT_TIMEOUT_KEY}`;
  return 'the database could not be reached';
}
