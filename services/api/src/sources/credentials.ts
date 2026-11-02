import type { SourceModel } from '../mapping/model.js';
import type { DriverSettings } from './driver.js';

export interface SourceCredentials {
  readonly username: string;
  readonly password: string;
}

/** The sign-in a source's mapping names by reference, read from the environment; undefined when either variable is unset or empty. */
export function credentialsOf(source: SourceModel, env: Readonly<Record<string, string | undefined>>): SourceCredentials | undefined {
  const username = env[source.auth.usernameEnv];
  const password = env[source.auth.passwordEnv];
  if (username === undefined || username === '' || password === undefined || password === '') return undefined;
  return { username, password };
}

/** The driver settings of a source: its address, its sign-in and its budgets, with the pool size the caller needs. */
export function driverSettingsOf(source: SourceModel, credentials: SourceCredentials, maxConnectionPoolSize: number): DriverSettings {
  return {
    uri: source.uri,
    username: credentials.username,
    password: credentials.password,
    maxConnectionPoolSize,
    connectionAcquisitionTimeout: source.budgets.queueWaitMs,
    connectionTimeout: source.budgets.timeoutMs,
  };
}
