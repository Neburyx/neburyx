import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { isInContainer, warnIfExposed } from './exposure.js';
import { IdentityStartError } from './identity/errors.js';
import { createIdentityStore, type IdentityStore } from './identity/store.js';

export interface StartIo {
  readonly stderr: { write(text: string): unknown };
  readonly logger: FastifyBaseLogger;
  readonly defaultWebRoot: string;
  readonly portOverride?: number;
  readonly openIdentity?: (url: string, onConnectionError: () => void) => IdentityStore;
  readonly fileExists?: (path: string) => boolean;
}

export type StartResult = { readonly exitCode: 0; readonly app: FastifyInstance } | { readonly exitCode: 1 };

function hasReadableIndex(webRoot: string): boolean {
  try {
    const index = join(webRoot, 'index.html');
    accessSync(index, constants.R_OK);
    return statSync(index).isFile();
  } catch {
    return false;
  }
}

function describeStartFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'EADDRINUSE':
      return 'NEBURYX_PORT is already in use';
    case 'EACCES':
      return 'NEBURYX_PORT needs more privileges than this process has';
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'NEBURYX_HOST is not an address of this machine';
    default:
      return typeof code === 'string' ? `start-up failed (${code})` : 'start-up failed';
  }
}

export async function start(env: Readonly<Record<string, string | undefined>>, io: StartIo): Promise<StartResult> {
  let config;
  try {
    config = parseConfig(env, { webRoot: io.defaultWebRoot });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return { exitCode: 1 };
  }

  if (!hasReadableIndex(config.webRoot)) {
    io.stderr.write('invalid configuration: NEBURYX_WEB_ROOT has no readable index.html\n');
    return { exitCode: 1 };
  }

  let identity: IdentityStore | undefined;
  let app: FastifyInstance | undefined;
  try {
    identity = (io.openIdentity ?? createIdentityStore)(config.databaseUrl, () =>
      io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
    );
    await identity.initialize();
    warnIfExposed(io.logger, config.host, isInContainer(env, io.fileExists ?? existsSync));
    app = await buildApp({ webRoot: config.webRoot, logger: io.logger, identity });
    await app.listen({ host: config.host, port: io.portOverride ?? config.port });
    return { exitCode: 0, app };
  } catch (error) {
    io.stderr.write(`${error instanceof IdentityStartError ? error.message : describeStartFailure(error)}\n`);
    if (app) await app.close();
    else await identity?.close();
    return { exitCode: 1 };
  }
}
