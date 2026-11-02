import { fileURLToPath } from 'node:url';
import type { SourceTestReport } from '@neburyx/contracts';
import { createAppStore, type AppStore } from '../app-store.js';
import { TEST_SOURCE_USAGE, parseTestSourceArgs } from '../commands.js';
import { ConfigError, parseCommandConfig } from '../config.js';
import { errorCode, isConnectionError } from '../database-errors.js';
import { AppError } from '../errors.js';
import { createSourceGate, type SourceGate, type SourceGateOptions } from '../gate/source-gate.js';
import type { Clock, GateLogger } from '../gate/types.js';
import { MappingError } from '../mapping/diagnostics.js';
import { loadMappingFile } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import { runWriteProbe, type ProbeDriverFactory } from '../sources/write-probe.js';
import type { ProbeAnswer, WriteProbe } from './probe.js';
import { createSourceTester } from './tester.js';
import { ALL_UNCHECKED } from './usability.js';

const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

const USAGE_ERROR = 2;
const FAILURE = 1;

export type CommandStore = Pick<AppStore, 'current' | 'hasActiveSource' | 'recordSourceCheck' | 'close'>;

export interface TestSourceIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly logger?: GateLogger;
  readonly clock?: Clock;
  readonly migrationsDirectory?: string;
  readonly openStore?: (url: string, directory: string) => CommandStore;
  readonly openSourceGate?: (options: SourceGateOptions) => SourceGate;
  /** Opens the driver of the write probe; the tests give a fake. */
  readonly openProbeDriver?: ProbeDriverFactory;
}

const NEVER_LOG: GateLogger = { warn: () => undefined };

class CommandFailure extends Error {}

const IDENTITY_MESSAGE = 'the local identity is missing; start the API once so that it creates it\n';

function databaseMessage(error: unknown): string | undefined {
  if (isConnectionError(error)) return 'the database could not be reached\n';
  if (errorCode(error) === '42P01' || errorCode(error) === '42703') return 'the database schema is behind this version; run neburyx migrate\n';
  return undefined;
}

function describeFailure(error: unknown): string {
  if (error instanceof CommandFailure) return error.message;
  if (error instanceof AppError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return 'the database does not know this source yet; start the API once so that it creates the local identity and the sources\n';
      case 'SOURCE_BUSY':
        return 'the source is busy; try again shortly\n';
      case 'QUERY_TIMEOUT':
        return 'the source did not answer in time; try again\n';
      case 'ACCESS_DENIED':
        return 'you are not allowed to test this source\n';
      default:
        return 'the source could not be tested; try again\n';
    }
  }
  return databaseMessage(error) ?? 'the source could not be tested; try again\n';
}

const READ_ONLY_WORDS: Readonly<Record<SourceTestReport['readOnlyCheck'], string>> = {
  'privileges-inspected': 'privileges inspected',
  'not-verified': 'not verified',
  'write-probe': 'write probe',
};

const PROBE_LINES: Readonly<Record<ProbeAnswer, string>> = {
  'can-write': 'Write probe: login can write',
  'cannot-write': 'Write probe: the server refused to create a node',
  inconclusive: 'Write probe: could not be completed',
};

/** The line about the probe that follows the report: what it found, or why it did not run. */
function probeLine(report: SourceTestReport, answer: ProbeAnswer | undefined): string {
  if (report.outcome === 'fail') return 'Write probe: not run, the source did not answer';
  if (report.versionSupported !== true) return 'Write probe: not run, the server version is not on the support matrix';
  return PROBE_LINES[answer ?? 'inconclusive'];
}

const MAPPING_WORDS: Readonly<Record<SourceTestReport['mappingChecks']['status'], string>> = {
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
  'not-run': 'not run',
  'not-verified': 'not verified',
};

function lines(report: SourceTestReport): string {
  const server = report.server === null ? 'not reached' : `${report.server.product} ${report.server.version} (${report.server.edition})`;
  const supported = report.versionSupported === null ? 'unknown' : report.versionSupported ? 'yes' : 'no';
  const operations = report.operations.map((operation) => `${operation.name} (${operation.status})`).join(', ');
  const mapping = report.mappingSummary;
  return [
    `Source: ${report.sourceId}`,
    `Outcome: ${report.outcome}`,
    `State: ${report.state}`,
    ...(report.stateReason === null ? [] : [`Reason: ${report.stateReason}`]),
    `Server: ${server}`,
    `Version supported: ${supported}`,
    `Operations: ${operations === '' ? 'none' : operations}`,
    `Mapping: ${mapping.entityTypes} entity types, ${mapping.relationshipTypes} relationship types, ${mapping.derivedRules} derived rules`,
    `Read-only: ${READ_ONLY_WORDS[report.readOnlyCheck]}`,
    `Login can write: ${report.loginCanWrite === null ? 'unknown' : report.loginCanWrite ? 'yes' : 'no'}`,
    `Mapping checks: ${MAPPING_WORDS[report.mappingChecks.status]}`,
    ...report.mappingChecks.findings.map((finding) => `  ${finding.severity}: ${finding.message}`),
    `Checked at: ${report.checkedAt}`,
    '',
  ].join('\n');
}

/**
 * `neburyx test-source --name <source> [--write-probe]`: tests one configured source as the local identity and prints the report; the flag also runs the write probe.
 * Exit 0 for pass and warn, 1 for fail and for any configuration, database or run error, 2 for a usage error or an unknown source name.
 */
export async function runTestSourceCommand(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: TestSourceIo): Promise<number> {
  const parsed = parseTestSourceArgs(args);
  if (parsed === undefined) {
    io.stderr.write(TEST_SOURCE_USAGE);
    return USAGE_ERROR;
  }
  const { name } = parsed;

  let config;
  try {
    config = parseCommandConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return FAILURE;
  }
  if (config.mappingPath === undefined) {
    io.stderr.write('test-source needs NEBURYX_CONFIG, the path of the mapping file\n');
    return FAILURE;
  }

  let mapping;
  try {
    mapping = loadMappingFile(config.mappingPath);
  } catch (error) {
    if (!(error instanceof MappingError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return FAILURE;
  }
  if (!mapping.sources.some((source) => source.id === name)) {
    io.stderr.write(`no source named ${name} is configured; configured sources: ${mapping.sources.map((source) => source.id).join(', ') || 'none'}\n`);
    return USAGE_ERROR;
  }

  const logger = io.logger ?? NEVER_LOG;
  // the probe's one line of trouble (a rollback that failed) is what an operator needs to see, so it reaches stderr as a line of fields
  const probeLogger: GateLogger = io.logger ?? { warn: (fields) => void io.stderr.write(`${JSON.stringify(fields)}\n`) };
  const directory = io.migrationsDirectory ?? SHIPPED_MIGRATIONS;
  const store = (io.openStore ?? ((url, migrations) => createAppStore(url, () => undefined, { migrationsDirectory: migrations })))(config.databaseUrl, directory);
  let sourceGate: SourceGate | undefined;
  try {
    sourceGate = (io.openSourceGate ?? createSourceGate)({ mapping, env, seams: communitySeams(), logger, usability: ALL_UNCHECKED, ...(io.clock === undefined ? {} : { clock: io.clock }) });
    const identity = await store.current().catch((error: unknown) => {
      throw new CommandFailure(databaseMessage(error) ?? IDENTITY_MESSAGE);
    });
    const probed: { answer?: ProbeAnswer } = {};
    const probe: WriteProbe = async (source, traceId) => {
      // said before the probe opens its transaction, on the stream that is not the report
      io.stderr.write(`write probe: opening a write transaction on source ${source.id} and rolling it back\n`);
      probed.answer = await runWriteProbe(source, traceId, { env, logger: probeLogger, ...(io.openProbeDriver === undefined ? {} : { createDriver: io.openProbeDriver }) });
      return probed.answer;
    };
    const tester = createSourceTester({ gate: sourceGate.gate, mapping, store, ...(io.clock === undefined ? {} : { clock: io.clock }), ...(parsed.writeProbe ? { probe } : {}), logger });
    const report = await tester.run({ traceId: `tr-cli-${Date.now()}`, principal: identity.principal, sourceId: name });
    io.stdout.write(lines(report) + (parsed.writeProbe ? `${probeLine(report, probed.answer)}\n` : ''));
    return report.outcome === 'fail' ? FAILURE : 0;
  } catch (error) {
    io.stderr.write(describeFailure(error));
    return FAILURE;
  } finally {
    await sourceGate?.close();
    await store.close();
  }
}
