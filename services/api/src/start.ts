import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MountedAuditSink, ProfileExtension } from '@neburyx/contracts';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, parseConfig } from './config.js';
import { createCursorCodec } from './gate/cursor/codec.js';
import { isInContainer, warnIfExposed } from './exposure.js';
import { IdentityStartError } from './identity/errors.js';
import { MappingError } from './mapping/diagnostics.js';
import { loadMappingFile } from './mapping/load.js';
import { aiMappingViewOf } from './profile/mapping-view.js';
import { causeOf, EXTENSION_CONFIGURE_FAILED_MESSAGE, loadProfileExtension, registeredExtensionLoader, type ExtensionLoader } from './profile/extension.js';
import { decidePreviewSwitch, previewInputsOf } from './profile/switch.js';
import type { MappingModel } from './mapping/model.js';
import { createAppStore, STORE_QUERY_TIMEOUT_MS, STORE_STATEMENT_TIMEOUT_MS, type AppStore } from './app-store.js';
import { createAddressCache, lookupStream } from './db/lookup.js';
import { POOL_SIZE } from './db/pool.js';
import { uuidv7 } from './identity/uuid.js';
import { communitySeams } from './seams/community-seams.js';
import { createSourceGate, type SourceGate, type SourceGateOptions } from './gate/source-gate.js';
import { SourceGateError } from './gate/allowlist.js';
import { createReachabilityCache, seedFromStartup } from './source-ping/cache.js';
import { createPingOutcomeLog } from './source-ping/outcome-log.js';
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
import { exportDirectoryProblem } from './exports/directory.js';
import { createExportFileStore } from './exports/store.js';
import { maintenanceTasks } from './jobs/maintenance.js';
import { TaskConfigError, validateTasks, type Task } from './jobs/tasks.js';

const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export interface StartIo {
  readonly stderr: { write(text: string): unknown };
  readonly logger: FastifyBaseLogger;
  readonly defaultWebRoot: string;
  /** Where export files go when `NEBURYX_EXPORT_DIR` is not set; the shipped default unless a test names its own. */
  readonly defaultExportDirectory?: string;
  readonly portOverride?: number;
  readonly pingIntervalMs?: number;
  readonly startupProblem?: (results: readonly StartupResult[]) => string | undefined;
  readonly openSourceGate?: (options: SourceGateOptions) => SourceGate;
  readonly openStore?: (url: string, onConnectionError: () => void, migrationsDirectory: string, previewMigrationsDirectory?: string) => AppStore;
  readonly migrationsDirectory?: string;
  readonly tasks?: readonly Task[];
  /** Starts the job runner; the shipped one unless a test says otherwise. */
  readonly startJobRunner?: typeof startJobRunner;
  readonly fileExists?: (path: string) => boolean;
  /** The loader of the enterprise extension; the registered one unless a test names its own. */
  readonly extensionLoader?: ExtensionLoader;
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
    config = parseConfig(env, { webRoot: io.defaultWebRoot, ...(io.defaultExportDirectory === undefined ? {} : { exportDirectory: io.defaultExportDirectory }) });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return { exitCode: 1 };
  }

  if (!hasReadableIndex(config.webRoot)) {
    io.stderr.write('invalid configuration: NEBURYX_WEB_ROOT has no readable index.html\n');
    return { exitCode: 1 };
  }

  const exportProblem = exportDirectoryProblem(config.exportDirectory);
  if (exportProblem !== undefined) {
    io.stderr.write(`invalid configuration: NEBURYX_EXPORT_DIR ${exportProblem}\n`);
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

  let decision;
  try {
    decision = decidePreviewSwitch(previewInputsOf(env, mapping));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return { exitCode: 1 };
  }
  if (decision.state === 'refused') {
    io.stderr.write(`${decision.message}\n`);
    return { exitCode: 1 };
  }

  let extension: ProfileExtension | undefined;
  if (decision.state === 'on') {
    const loaded = await loadProfileExtension(io.extensionLoader ?? registeredExtensionLoader());
    if (!loaded.ok) {
      if (loaded.cause !== undefined) io.logger.error({ event: 'profile.extension_load_failed', cause: loaded.cause }, 'enterprise extension could not be loaded');
      io.stderr.write(`${loaded.message}\n`);
      return { exitCode: 1 };
    }
    extension = loaded.extension;
    io.logger.info({ event: 'profile.extension_loaded', extension: extension.name }, 'enterprise extension loaded');
    if (extension.configure !== undefined) {
      let outcome;
      try {
        outcome = await extension.configure(mapping.ai ?? {}, env, aiMappingViewOf(mapping));
      } catch (error) {
        io.logger.error({ event: 'profile.extension_configure_failed', cause: causeOf(error) }, 'enterprise extension could not be configured');
        io.stderr.write(`${EXTENSION_CONFIGURE_FAILED_MESSAGE}\n`);
        return { exitCode: 1 };
      }
      if (!outcome.ok) {
        for (const problem of outcome.problems) io.stderr.write(`invalid configuration: ${problem}\n`);
        return { exitCode: 1 };
      }
      for (const warning of outcome.warnings ?? []) io.logger.warn({ event: warning.event }, warning.message);
    }
  }

  try {
    if (io.tasks !== undefined) validateTasks(io.tasks);
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
  let mountedAudit: MountedAuditSink | undefined;
  try {
    const addresses = createAddressCache();
    const openStore = io.openStore ?? ((url, report, directory, preview) => createAppStore(url, report, { migrationsDirectory: directory, connectionTimeoutMs: config.connectTimeoutMs, readinessLimitMs: config.readinessLimitMs, addresses, ...(preview === undefined ? {} : { previewMigrationsDirectory: preview }) }));
    store = openStore(
      config.databaseUrl,
      () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
      io.migrationsDirectory ?? SHIPPED_MIGRATIONS,
      extension?.migrationsDirectory,
    );
    // the checks that count for this process are the ones stored from here on
    const startedAt = new Date().toISOString();
    await store.initialize();
    const openedStore = store;
    const exportFiles = createExportFileStore(config.exportDirectory);
    const usability = createUsabilityRecord();
    const observingStore = observingStoreOf(openedStore, usability);
    for (const sourceId of await store.syncSources(mapping.sources)) {
      io.logger.warn({ event: 'source.identity_changed', sourceId }, 'source now points to a different database');
    }
    // a key that is not configured is made for this process only, so a page opened before a restart, or on another copy, says "Start again"
    if (config.cursorKey === undefined) io.logger.warn({ event: 'cursor.key_not_set' }, 'NEBURYX_CURSOR_KEY is not set: page cursors do not survive a restart and are not valid across API copies');
    const cursors = createCursorCodec({ key: config.cursorKey ?? randomBytes(32), clock: Date.now });
    const referenceKeys = deriveReferenceKeys(await store.referenceKey());
    // one set of seams for the process: the gate's read slots are the app's
    const community = communitySeams();
    // the preview's sink writes with the application's own login and the limits of the application's pool
    mountedAudit = extension?.createAuditSink?.({
      databaseUrl: config.databaseUrl,
      poolSize: POOL_SIZE,
      connectionTimeoutMs: config.connectTimeoutMs,
      connectionStream: lookupStream(addresses),
      statementTimeoutMs: STORE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: STORE_QUERY_TIMEOUT_MS,
      newId: uuidv7,
      onConnectionError: () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
    });
    const seams = mountedAudit === undefined ? community : { ...community, audit: mountedAudit.sink };
    sourceGate = (io.openSourceGate ?? createSourceGate)({ mapping, env, seams, logger: io.logger, cursors, referenceKeys });
    const gate = sourceGate;
    const results = await createStartupChecker({ system: gate.system, mapping, store: observingStore, logger: io.logger }).run();
    const reachability = createReachabilityCache(mapping.sources.map((source) => source.id));
    seedFromStartup(reachability, results);
    const problem = (io.startupProblem ?? startupProblem)(results);
    if (problem !== undefined) throw new StartupStop(problem);
    const tasks = io.tasks ?? maintenanceTasks({ store: openedStore, exports: openedStore, files: exportFiles, audit: seams.audit, logger: io.logger });
    validateTasks(tasks);
    jobs = await (io.startJobRunner ?? startJobRunner)(
      config.databaseUrl,
      tasks,
      io.logger,
      () => io.logger.warn({ event: 'database.connection_error' }, 'database connection error'),
      { connectionTimeoutMs: config.connectTimeoutMs, addresses },
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
      catalog: gate.catalog,
      seams,
      extension,
      previewOn: decision.state === 'on',
      referenceKeys,
      cursors,
      exportFiles,
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
      closeSources: async () => {
        await gate.close();
        await mountedAudit?.close();
      },
    });
    await app.listen({ host: config.host, port: io.portOverride ?? config.port });
    const pingIntervalMs = io.pingIntervalMs ?? PING_INTERVAL_MS;
    const contact = createFirstContact({ system: gate.system, mapping, store: observingStore, record: usability, logger: io.logger, intervalMs: pingIntervalMs });
    firstContact = contact;
    const logPingOutcomes = createPingOutcomeLog(io.logger);
    pingSchedule = startPingSchedule({
      ping: createScheduledPing({ system: gate.system, mapping, cache: reachability }),
      intervalMs: pingIntervalMs,
      onResults: async (results) => {
        logPingOutcomes(results);
        await applyPingResults(openedStore, io.logger, results, { mapping });
        await refreshUsability(openedStore, usability, mapping, startedAt, io.logger);
        contact.afterTick(results);
      },
      onFailure: () => io.logger.warn({ event: 'source.ping_failed' }, 'source ping failed'),
      onOverlap: () => io.logger.warn({ event: 'source.ping_overlap' }, 'source ping run has not ended before the next one is due'),
    });
    return { exitCode: 0, app };
  } catch (error) {
    io.stderr.write(`${error instanceof IdentityStartError || error instanceof SourceGateError || error instanceof StartupStop ? error.message : describeStartFailure(error)}\n`);
    if (app) await app.close();
    else {
      await jobs?.stop();
      await sourceGate?.close();
      await mountedAudit?.close();
      await store?.close();
    }
    return { exitCode: 1 };
  }
}
