import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { createCursorCodec } from './gate/cursor/codec.js';
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
import { createFirstContact, type FirstContact } from './source-test/first-contact.js';
import { deriveReferenceKeys } from './reference/keys.js';
import { observingStoreOf } from './source-test/observing-store.js';
import { createUsabilityRecord } from './source-test/usability.js';
import { refreshUsability } from './source-test/usability-refresh.js';
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
  let firstContact: FirstContact | undefined;
  try {
    const openStore = io.openStore ?? ((url, report, directory) => createAppStore(url, report, { migrationsDirectory: directory }));
    store = openStore(
      config.databaseUrl,
      () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
      io.migrationsDirectory ?? SHIPPED_MIGRATIONS,
    );
    // the checks that count for this process are the ones stored from here on
    const startedAt = new Date().toISOString();
    await store.initialize();
    const openedStore = store;
    const usability = createUsabilityRecord();
    const observingStore = observingStoreOf(openedStore, usability);
    for (const sourceId of await store.syncSources(mapping.sources)) {
      io.logger.warn({ event: 'source.identity_changed', sourceId }, 'source now points to a different database');
    }
    // a key that is not configured is made for this process only, so a page opened before a restart, or on another copy, says "Start again"
    if (config.cursorKey === undefined) io.logger.warn({ event: 'cursor.key_not_set' }, 'NEBURYX_CURSOR_KEY is not set: page cursors do not survive a restart and are not valid across API copies');
    const cursors = createCursorCodec({ key: config.cursorKey ?? randomBytes(32), clock: Date.now });
    const referenceKeys = deriveReferenceKeys(await store.referenceKey());
    sourceGate = (io.openSourceGate ?? createSourceGate)({ mapping, env, seams: communitySeams(), logger: io.logger, usability, cursors, referenceKeys });
    const gate = sourceGate;
    const results = await createStartupChecker({ system: gate.system, mapping, store: observingStore, logger: io.logger }).run();
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
      sourceTester: createSourceTester({ gate: gate.gate, mapping, store: observingStore, logger: io.logger }),
      gate: gate.gate,
      referenceKeys,
      degreeVerdicts: usability,
      indexes: gate.indexes,
      reachability,
      stopPing: () => {
        pingSchedule?.stop();
        firstContact?.stop();
      },
      // a first-contact check that was already running ends before the sources and the store are closed
      drainPing: async () => {
        await pingSchedule?.drain();
        await firstContact?.drain();
      },
      closeSources: () => gate.close(),
    });
    await app.listen({ host: config.host, port: io.portOverride ?? config.port });
    const pingIntervalMs = io.pingIntervalMs ?? PING_INTERVAL_MS;
    const contact = createFirstContact({ system: gate.system, mapping, store: observingStore, record: usability, logger: io.logger, intervalMs: pingIntervalMs });
    firstContact = contact;
    pingSchedule = startPingSchedule({
      ping: createScheduledPing({ system: gate.system, mapping, cache: reachability }),
      intervalMs: pingIntervalMs,
      onResults: async (results) => {
        await applyPingResults(openedStore, io.logger, results, { mapping, since: startedAt });
        await refreshUsability(openedStore, usability, mapping, startedAt, io.logger);
        contact.afterTick(results);
      },
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
