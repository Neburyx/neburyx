import type { MappingChecks, MappingFinding } from '@neburyx/contracts';
import type { ZodType } from 'zod';
import { AppError } from '../errors.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { schemaIndexesItemSchema, SCHEMA_INDEXES_ID } from '../gate/templates/schema-indexes.js';
import { schemaTokensItemSchema, SCHEMA_TOKENS_ID } from '../gate/templates/schema-tokens.js';
import { duplicatesItemSchema, STABLE_ID_DUPLICATES_ID } from '../gate/templates/stable-id-duplicates.js';
import { isUnreadable } from '../gate/templates/unreadable.js';
import type { Clock, GateLogger, GatePage } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { entitiesToScan, checksOf, judgeIndexes, judgeScan, judgeTokens, refusedFinding, unreadableFinding, type SchemaReads } from './mapping-checks.js';
import type { CheckRun } from './check.js';

/** The stage starts a read only while less than this long has passed since it began, so it ends at most one gate deadline after that. */
export const STAGE_START_WINDOW_MS = 2 * DEFAULT_BUDGETS.requestTimeoutMs;

type Read<T> = { readonly kind: 'item'; readonly item: T } | { readonly kind: 'refused' } | { readonly kind: 'unreadable'; readonly shape: readonly Record<string, string>[] } | { readonly kind: 'timeout' };

const isRefused = (error: unknown): boolean => error instanceof AppError && error.code === 'SOURCE_UNAVAILABLE' && error.reason === 'refused';
/** A schema read is one row; the gate refuses an answer with more as cut, which is an answer the check cannot read. */
const isCut = (error: unknown): boolean => error instanceof AppError && error.code === 'INTERNAL_ERROR' && error.reason === 'read-cut';

/**
 * One read of the stage. A refusal and an answer the template cannot read are results of their own; a timeout is returned only when the caller asks for it
 * (the duplicate scan); anything else is rethrown, because it says nothing about the mapping and nothing is stored for it.
 */
async function readOne<T>(run: CheckRun, request: { traceId: string; sourceId: string; templateId: string; params: unknown }, schema: ZodType<T>, timeoutIsResult: boolean): Promise<Read<T>> {
  let page: GatePage;
  try {
    page = await run({ ...request, limit: 1 });
  } catch (error) {
    if (isRefused(error)) return { kind: 'refused' };
    if (isCut(error)) return { kind: 'unreadable', shape: [] };
    if (timeoutIsResult && error instanceof AppError && error.code === 'QUERY_TIMEOUT') return { kind: 'timeout' };
    throw error;
  }
  const [item] = page.items;
  if (page.items.length !== 1 || item === undefined) return { kind: 'unreadable', shape: [] };
  if (isUnreadable(item)) return { kind: 'unreadable', shape: [item.unreadable] };
  const parsed = schema.safeParse(item);
  return parsed.success ? { kind: 'item', item: parsed.data } : { kind: 'unreadable', shape: [] };
}

function logUnreadable(logger: GateLogger | undefined, sourceId: string, read: string, shape: readonly Record<string, string>[]): void {
  // the type of each column, never a value
  logger?.warn({ event: 'source.schema_unreadable', sourceId, read, columnTypes: shape }, 'source schema answer could not be read');
}

export interface MappingStageDeps {
  readonly clock: Clock;
  readonly logger?: GateLogger | undefined;
}

/**
 * Checks the mapping against the source with the schema reads, one after another. Findings made before a read is refused or cannot be read are kept.
 * A read that fails for any other reason is rethrown and the whole check stores nothing.
 */
export async function checkMapping(source: SourceModel, run: CheckRun, traceId: string, deps: MappingStageDeps): Promise<MappingChecks> {
  const started = deps.clock();
  const request = (templateId: string, params: unknown) => ({ traceId, sourceId: source.id, templateId, params });
  const findings: MappingFinding[] = [];

  const tokens = await readOne(run, request(SCHEMA_TOKENS_ID, {}), schemaTokensItemSchema, false);
  if (tokens.kind === 'refused') return checksOf([refusedFinding('tokens')]);
  if (tokens.kind === 'unreadable') {
    logUnreadable(deps.logger, source.id, 'tokens', tokens.shape);
    return checksOf([unreadableFinding('tokens')]);
  }
  if (tokens.kind !== 'item') return checksOf([unreadableFinding('tokens')]);
  const present = { labels: new Set(tokens.item.labels), types: new Set(tokens.item.types) };
  findings.push(...judgeTokens(source, present));
  if (present.labels.size === 0 && present.types.size === 0) return checksOf(findings);

  const indexes = await readOne(run, request(SCHEMA_INDEXES_ID, {}), schemaIndexesItemSchema, false);
  if (indexes.kind === 'refused') return checksOf([...findings, refusedFinding('indexes')]);
  if (indexes.kind !== 'item' || indexes.item.truncated) {
    if (indexes.kind === 'unreadable') logUnreadable(deps.logger, source.id, 'indexes', indexes.shape);
    return checksOf([...findings, unreadableFinding('indexes')]);
  }
  const reads: SchemaReads = { ...present, indexes: indexes.item.indexes };
  findings.push(...judgeIndexes(source, reads));

  for (const entity of entitiesToScan(source, reads)) {
    if (deps.clock() - started >= STAGE_START_WINDOW_MS) {
      findings.push(...judgeScan(entity, 'unverified'));
      continue;
    }
    const scan = await readOne(run, request(STABLE_ID_DUPLICATES_ID, { entityType: entity.type }), duplicatesItemSchema, true);
    if (scan.kind === 'refused') return checksOf([...findings, refusedFinding('scan')]);
    if (scan.kind === 'unreadable') {
      logUnreadable(deps.logger, source.id, 'scan', scan.shape);
      return checksOf([...findings, unreadableFinding('scan')]);
    }
    findings.push(...judgeScan(entity, scan.kind === 'item' ? { duplicated: scan.item.duplicated } : 'unverified'));
  }
  return checksOf(findings);
}
