import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { isInContainer, warnIfExposed } from './exposure.js';
import { IdentityStartError } from './identity/errors.js';
import { MappingError } from './mapping/diagnostics.js';
import { loadMappingFile } from './mapping/load.js';
import type { MappingModel } from './mapping/model.js';
import { createAppStore, type AppStore } from './app-store.js';
import { communitySeams } from './seams/community-seams.js';
import { createSourceGate, type SourceGate, type SourceGateOptions } from './gate/source-gate.js';
import { SourceGateError } from './gate/allowlist.js';
import { createReachabilityCache, seedFromStartup } from './source-ping/cache.js';
import { createScheduledPing } from './source-ping/ping.js';
import { applyPingResults } from './source-ping/state.js';
import { PING_INTERVAL_MS, startPingSchedule, type PingSchedule } from './source-ping/schedule.js';
import { createStartupChecker, startupProblem, type StartupResult } from './source-test/startup.js';
import { createSourceTester } from './source-test/tester.js';
import { startJobRunner, type JobRunner } from './jobs/runner.js';
import { registeredTasks, TaskConfigError, validateTasks, type Task } from './jobs/tasks.js';

const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export interface StartIo {
  readonly stderr: { write(text: string): unknown };
  readonly logger: FastifyBaseLogger;
  readonly defaultWebRoot: string;
  readonly portOverride?: number;
  readonly pingIntervalMs?: number;
  readonly startupProblem?: (results: readonly StartupResult[]) => string | undefined;
  readonly openSourceGate?: (options: SourceGateOptions) => SourceGate;
  readonly openStore?: (url: string, onConnectionError: () => void, migrationsDirectory: string) => AppStore;
  readonly migrationsDirectory?: string;
  readonly tasks?: readonly Task[];
  readonly fileExists?: (path: string) => boolean;
}

class StartupStop extends Error {}

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
    case '42P01':
    case '42703':
      return 'the database schema is behind this version; run neburyx migrate';
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

  let mapping: MappingModel = { sources: [] };
  if (config.mappingPath !== undefined) {
    try {
      mapping = loadMappingFile(config.mappingPath);
    } catch (error) {
      if (!(error instanceof MappingError)) throw error;
      io.stderr.write(`${error.message}\n`);
      return { exitCode: 1 };
    }
  }

  const tasks = io.tasks ?? registeredTasks;
  try {
    validateTasks(tasks);
  } catch (error) {
    if (!(error instanceof TaskConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return { exitCode: 1 };
  }

  let store: AppStore | undefined;
  let jobs: JobRunner | undefined;
  let sourceGate: SourceGate | undefined;
  let app: FastifyInstance | undefined;
  let pingSchedule: PingSchedule | undefined;
  try {
    const openStore = io.openStore ?? ((url, report, directory) => createAppStore(url, report, { migrationsDirectory: directory }));
    store = openStore(
      config.databaseUrl,
      () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
      io.migrationsDirectory ?? SHIPPED_MIGRATIONS,
    );
    await store.initialize();
    const openedStore = store;
    for (const sourceId of await store.syncSources(mapping.sources)) {
      io.logger.warn({ event: 'source.identity_changed', sourceId }, 'source now points to a different database');
    }
    sourceGate = (io.openSourceGate ?? createSourceGate)({ mapping, env, seams: communitySeams(), logger: io.logger });
    const gate = sourceGate;
    const results = await createStartupChecker({ system: gate.system, mapping, store: openedStore, logger: io.logger }).run();
    const reachability = createReachabilityCache(mapping.sources.map((source) => source.id));
    seedFromStartup(reachability, results);
    const problem = (io.startupProblem ?? startupProblem)(results);
    if (problem !== undefined) throw new StartupStop(problem);
    jobs = await startJobRunner(
      config.databaseUrl,
      tasks,
      io.logger,
      () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
    );
    warnIfExposed(io.logger, config.host, isInContainer(env, io.fileExists ?? existsSync));
    app = await buildApp({
      webRoot: config.webRoot,
      logger: io.logger,
      store,
      jobs,
      mapping,
      sourceTester: createSourceTester({ gate: gate.gate, mapping, store: openedStore }),
      reachability,
      stopPing: () => pingSchedule?.stop(),
      drainPing: () => pingSchedule?.drain() ?? Promise.resolve(),
      closeSources: () => gate.close(),
    });
    await app.listen({ host: config.host, port: io.portOverride ?? config.port });
    pingSchedule = startPingSchedule({
      ping: createScheduledPing({ system: gate.system, mapping, cache: reachability }),
      intervalMs: io.pingIntervalMs ?? PING_INTERVAL_MS,
      onResults: (results) => applyPingResults(openedStore, io.logger, results),
      onFailure: () => io.logger.warn({ event: 'source.ping_failed' }, 'source ping failed'),
    });
    return { exitCode: 0, app };
  } catch (error) {
    io.stderr.write(`${error instanceof IdentityStartError || error instanceof SourceGateError || error instanceof StartupStop ? error.message : describeStartFailure(error)}\n`);
    if (app) await app.close();
    else {
      await jobs?.stop();
      await sourceGate?.close();
      await store?.close();
    }
    return { exitCode: 1 };
  }
}
