import neo4j from 'neo4j-driver';
import type { MappingSource } from './mapping.js';
import type { Value } from './rules.js';
import { BATCH_SIZE, BATCH_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, RESET_BATCH_SIZE } from './settings.js';
import { checkOffline, SafetyError } from './safety.js';
import { quote, schemaStatements } from './schema.js';
import { ExportError, readExport, type ExportData, type Properties } from './validate.js';

export interface LoaderResult {
  readonly records: readonly { get(key: string): unknown }[];
}

export interface LoaderTransaction {
  run(cypher: string, parameters?: Record<string, unknown>): PromiseLike<LoaderResult>;
  commit(): PromiseLike<unknown>;
  rollback(): PromiseLike<unknown>;
}

export interface LoaderSession {
  beginTransaction(config: { timeout: number }): PromiseLike<LoaderTransaction>;
  close(): PromiseLike<unknown>;
}

export interface LoaderDriver {
  session(config: { database: string }): LoaderSession;
  verifyConnectivity(): PromiseLike<unknown>;
  close(): PromiseLike<unknown>;
}

export interface LoaderSettings {
  readonly uri: string;
  readonly user: string;
  readonly password: string;
  readonly connectionTimeout: number;
}

export type LoaderDriverFactory = (settings: LoaderSettings) => LoaderDriver;

export const neo4jLoaderDriver: LoaderDriverFactory = (settings) =>
  neo4j.driver(settings.uri, neo4j.auth.basic(settings.user, settings.password), { connectionTimeout: settings.connectionTimeout });

export class LoadError extends Error {
  readonly phase: string;
  readonly code: string;

  constructor(phase: string, detail: string, code: string) {
    super(`the load stopped while ${phase}${detail === '' ? '' : ` (${detail})`}: ${code}`);
    this.name = 'LoadError';
    this.phase = phase;
    this.code = code;
  }
}

export interface LoadOptions {
  readonly directory: string;
  readonly source: MappingSource;
  readonly override?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reset: boolean;
  readonly createDriver?: LoaderDriverFactory;
  readonly now?: () => number;
  readonly onPhase?: (name: string, milliseconds: number) => void;
}

export interface LoadReport {
  readonly phases: readonly { readonly name: string; readonly milliseconds: number }[];
  readonly totalMilliseconds: number;
  readonly nodes: Readonly<Record<string, number>>;
  readonly relationships: Readonly<Record<string, number>>;
}

const SERVER_CODE = /^Neo\.[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+$/;
const DRIVER_CODES: ReadonlySet<string> = new Set(['ServiceUnavailable', 'SessionExpired', 'ProtocolError']);

function codeOf(error: unknown): string {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && (SERVER_CODE.test(code) || DRIVER_CODES.has(code)) ? code : 'unknown';
}

function numbersIn(text: string): number[] {
  return text.split(/\D+/).filter((part) => part !== '').map(Number);
}

export function toDriverValue(value: Value): unknown {
  if (typeof value !== 'object') return value;
  if ('$int' in value) return neo4j.int(value.$int);
  if ('$date' in value) {
    const [year = 0, month = 0, day = 0] = numbersIn(value.$date);
    return new neo4j.Date(year, month, day);
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = numbersIn(value.$datetime);
  return new neo4j.DateTime(year, month, day, hour, minute, second, 0, 0);
}

function rowOf(properties: Properties): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, toDriverValue(value)]));
}

function countOf(value: unknown): number {
  return neo4j.isInt(value) ? value.toNumber() : Number(value);
}

function checkAgainstMapping(data: ExportData, source: MappingSource): void {
  if (data.manifest.sourceId !== source.id) throw new ExportError('manifest.json', 'was made for another source');
  const idsByType = new Map<string, Set<string>>();
  const seenEntityTypes = new Set<string>();
  for (const entity of data.entities) {
    const mapped = source.entities.find((candidate) => candidate.type === entity.type);
    if (mapped === undefined || mapped.label !== entity.label) throw new ExportError('manifest.json', 'lists an entity type the mapping does not have');
    if (seenEntityTypes.has(entity.type)) throw new ExportError('manifest.json', 'lists an entity type twice');
    seenEntityTypes.add(entity.type);
    const ids = new Set<string>();
    entity.rows.forEach((row, index) => {
      for (const key of Object.keys(row)) if (!mapped.properties.has(key)) throw new ExportError(entity.file, `record ${index + 1} holds a property the mapping does not use`);
      const id = row[mapped.stableId];
      if (typeof id !== 'string' || id === '') throw new ExportError(entity.file, `record ${index + 1} has no stable ID`);
      if (ids.has(id)) throw new ExportError(entity.file, `record ${index + 1} repeats a stable ID`);
      ids.add(id);
    });
    idsByType.set(entity.type, ids);
  }
  const seenRelationshipTypes = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const relationship of data.relationships) {
    const mapped = source.relationships.find((candidate) => candidate.type === relationship.type);
    if (mapped === undefined || mapped.from !== relationship.from || mapped.to !== relationship.to) throw new ExportError('manifest.json', 'lists a relationship type the mapping does not have');
    if (seenRelationshipTypes.has(relationship.type)) throw new ExportError('manifest.json', 'lists a relationship type twice');
    seenRelationshipTypes.add(relationship.type);
    const fromIds = idsByType.get(mapped.from);
    const toIds = idsByType.get(mapped.to);
    if (fromIds === undefined || toIds === undefined) throw new ExportError(relationship.file, 'connects an entity type the export does not hold');
    relationship.rows.forEach((row, index) => {
      for (const key of Object.keys(row.p)) if (!mapped.properties.has(key)) throw new ExportError(relationship.file, `record ${index + 1} holds a property the mapping does not use`);
      if (!fromIds.has(row.f) || !toIds.has(row.t)) throw new ExportError(relationship.file, `record ${index + 1} names a node the export does not hold`);
      if (mapped.stableId !== undefined) {
        const id = row.p[mapped.stableId];
        if (typeof id !== 'string' || id === '') throw new ExportError(relationship.file, `record ${index + 1} has no stable ID`);
        if (relationshipIds.has(id)) throw new ExportError(relationship.file, `record ${index + 1} repeats a stable ID of a relationship`);
        relationshipIds.add(id);
      }
    });
  }
}

async function inTransaction<T>(session: LoaderSession, work: (transaction: LoaderTransaction) => PromiseLike<T>): Promise<T> {
  const transaction = await session.beginTransaction({ timeout: BATCH_TIMEOUT_MS });
  try {
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // the failure of the work is the one that is reported; a rollback that also fails adds nothing the caller can use
    }
    throw error;
  }
}

function batches<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size) result.push(rows.slice(start, start + size));
  return result;
}

interface Progress {
  phase: string;
  detail: string;
}

async function attempt(close: () => PromiseLike<unknown> | undefined): Promise<boolean> {
  try {
    await close();
    return true;
  } catch {
    // the caller decides what a failed close means: it is reported only when nothing else went wrong
    return false;
  }
}

export async function loadExport(options: LoadOptions): Promise<LoadReport> {
  const now = options.now ?? (() => performance.now());
  const phases: { name: string; milliseconds: number }[] = [];
  let phaseStart = now();
  const started = phaseStart;
  const finishPhase = (name: string): void => {
    const end = now();
    phases.push({ name, milliseconds: end - phaseStart });
    options.onPhase?.(name, end - phaseStart);
    phaseStart = end;
  };

  const credentials = checkOffline(options.source, options.override, options.env);
  const data = readExport(options.directory);
  checkAgainstMapping(data, options.source);
  const statements = schemaStatements(options.source);
  finishPhase('validate');

  const progress: Progress = { phase: 'connecting', detail: '' };
  const nodes: Record<string, number> = {};
  const relationships: Record<string, number> = {};
  let driver: LoaderDriver | undefined;
  let session: LoaderSession | undefined;
  let failure: unknown;
  try {
    driver = (options.createDriver ?? neo4jLoaderDriver)({
      uri: options.override ?? options.source.uri,
      user: credentials.user,
      password: credentials.password,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    });
    session = driver.session({ database: options.source.database });
    await driver.verifyConnectivity();
    finishPhase('connect');
    await populate(session, options, data, statements, progress, finishPhase, nodes, relationships);
  } catch (error) {
    failure = error;
  }
  const closedSession = session === undefined ? true : await attempt(() => session?.close());
  const closedDriver = driver === undefined ? true : await attempt(() => driver?.close());
  if (failure !== undefined) {
    if (failure instanceof SafetyError || failure instanceof LoadError || failure instanceof ExportError) throw failure;
    throw new LoadError(progress.phase, progress.detail, codeOf(failure));
  }
  if (!closedSession || !closedDriver) throw new LoadError('cleaning up', '', 'close-failed');
  return { phases, totalMilliseconds: now() - started, nodes, relationships };
}

async function populate(
  session: LoaderSession,
  options: LoadOptions,
  data: ExportData,
  statements: readonly string[],
  progress: Progress,
  finishPhase: (name: string) => void,
  nodes: Record<string, number>,
  relationships: Record<string, number>,
): Promise<void> {
  progress.phase = 'checking that the database is empty';
  const existing = await inTransaction(session, async (transaction) => countOf((await transaction.run('MATCH (n) RETURN count(n) AS nodes')).records[0]?.get('nodes')));
  if (existing > 0 && !options.reset) throw new SafetyError('database-not-empty', 'the database already holds nodes; use the reset flag to clear it');
  if (existing > 0) {
    progress.phase = 'resetting the database';
    for (;;) {
      const deleted = await inTransaction(session, async (transaction) =>
        countOf((await transaction.run('MATCH (n) WITH n LIMIT $size DETACH DELETE n RETURN count(*) AS deleted', { size: neo4j.int(RESET_BATCH_SIZE) })).records[0]?.get('deleted')),
      );
      if (deleted === 0) break;
    }
  }
  finishPhase('reset');

  progress.phase = 'preparing constraints and indexes';
  for (const statement of statements) {
    progress.detail = '';
    await inTransaction(session, (transaction) => transaction.run(statement));
  }
  finishPhase('schema');

  progress.phase = 'loading nodes';
  for (const entity of data.entities) {
    const label = quote(entity.label);
    for (const [number, rows] of batches(entity.rows, BATCH_SIZE).entries()) {
      progress.detail = `${entity.label}, batch ${number + 1}`;
      await inTransaction(session, (transaction) => transaction.run(`UNWIND $rows AS row CREATE (n:${label}) SET n = row`, { rows: rows.map(rowOf) }));
    }
  }
  finishPhase('nodes');

  progress.phase = 'loading relationships';
  for (const relationship of data.relationships) {
    const mapped = options.source.relationships.find((candidate) => candidate.type === relationship.type);
    const from = options.source.entities.find((entity) => entity.type === mapped?.from);
    const to = options.source.entities.find((entity) => entity.type === mapped?.to);
    if (mapped === undefined || from === undefined || to === undefined) throw new ExportError('manifest.json', 'lists a relationship type the mapping does not have');
    const statement = `UNWIND $rows AS row MATCH (a:${quote(from.label)} {${quote(from.stableId)}: row.f}) MATCH (b:${quote(to.label)} {${quote(to.stableId)}: row.t}) CREATE (a)-[r:${quote(mapped.type)}]->(b) SET r = row.p`;
    for (const [number, rows] of batches(relationship.rows, BATCH_SIZE).entries()) {
      progress.detail = `${relationship.type}, batch ${number + 1}`;
      await inTransaction(session, (transaction) => transaction.run(statement, { rows: rows.map((row) => ({ f: row.f, t: row.t, p: rowOf(row.p) })) }));
    }
  }
  finishPhase('relationships');

  progress.phase = 'checking the counts';
  for (const entity of data.entities) {
    progress.detail = entity.label;
    nodes[entity.label] = await inTransaction(session, async (transaction) => countOf((await transaction.run(`MATCH (n:${quote(entity.label)}) RETURN count(n) AS found`)).records[0]?.get('found')));
    if (nodes[entity.label] !== entity.rows.length) throw new LoadError(progress.phase, `${entity.label}: found ${nodes[entity.label]}, expected ${entity.rows.length}`, 'count-mismatch');
  }
  for (const relationship of data.relationships) {
    progress.detail = relationship.type;
    relationships[relationship.type] = await inTransaction(session, async (transaction) => countOf((await transaction.run(`MATCH ()-[r:${quote(relationship.type)}]->() RETURN count(r) AS found`)).records[0]?.get('found')));
    if (relationships[relationship.type] !== relationship.rows.length) {
      throw new LoadError(progress.phase, `${relationship.type}: found ${relationships[relationship.type]}, expected ${relationship.rows.length}`, 'count-mismatch');
    }
  }
  finishPhase('verify');
}
