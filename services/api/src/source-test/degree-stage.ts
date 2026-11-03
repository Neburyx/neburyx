import type { DegreeChecks, DegreeType } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { DEGREE_PROBE_ID, degreeProbeItemSchema } from '../gate/templates/degree-probe.js';
import { isUnreadable } from '../gate/templates/unreadable.js';
import type { Clock, GateLogger } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import type { CheckRun } from './check.js';
import { judgePlan } from './degree-judge.js';

const SEVERITY: Readonly<Record<DegreeType['result'], number>> = { cheap: 0, 'could-not-tell': 1, 'not-cheap': 2 };

const COULD_NOT_CHECK = (entityType: string, why: string): string => `Degree counts could not be checked for ${entityType}: ${why}`;

/** The one sentence a type that is not `cheap` adds to the warnings. */
export function warningOf(entry: DegreeType): string | undefined {
  switch (entry.basis) {
    case 'degree-operator':
      return undefined;
    case 'expand':
      return `Degree counts are estimated for ${entry.entityType}: no cheap per-type degree index`;
    case 'unrecognized-plan':
    case 'no-plan':
      return COULD_NOT_CHECK(entry.entityType, "the server's plan was not one this check recognizes");
    case 'unreadable':
      return COULD_NOT_CHECK(entry.entityType, "the server's answer could not be read");
    case 'timeout':
      return COULD_NOT_CHECK(entry.entityType, 'the server did not answer in time');
    case 'refused':
      return COULD_NOT_CHECK(entry.entityType, 'the login may not profile');
    case 'skipped':
      return COULD_NOT_CHECK(entry.entityType, 'not checked in time');
  }
}

/** The stage starts a probe only while less than this long has passed since it began, so it ends at most one gate deadline after that. */
export const DEGREE_START_WINDOW_MS = DEFAULT_BUDGETS.requestTimeoutMs;

export const NOT_RUN_DEGREES: DegreeChecks = { status: 'not-run', foundOn: null, types: [], warnings: [] };

/** The (entity type, relationship type) pairs of a source in the order of its mapping: each end of each relationship row, once. */
export function degreePairs(source: SourceModel): { readonly entityType: string; readonly relationshipType: string }[] {
  const pairs: { entityType: string; relationshipType: string }[] = [];
  const seen = new Set<string>();
  for (const relationship of source.relationships) {
    for (const entityType of [relationship.from, relationship.to]) {
      const key = JSON.stringify([entityType, relationship.type]);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ entityType, relationshipType: relationship.type });
    }
  }
  return pairs;
}

export interface DegreeStageDeps {
  readonly clock: Clock;
  readonly logger?: GateLogger | undefined;
}

type Verdict = Pick<DegreeType, 'result' | 'basis'>;

const COULD_NOT_TELL = (basis: 'timeout' | 'refused' | 'skipped' | 'unreadable'): Verdict => ({ result: 'could-not-tell', basis });

const isRefused = (error: unknown): boolean => error instanceof AppError && error.code === 'SOURCE_UNAVAILABLE' && error.reason === 'refused';

/**
 * One probe. A refusal, a timeout and an answer the template cannot read are results of their own; anything else says nothing about the source and is rethrown.
 */
async function probe(source: SourceModel, run: CheckRun, traceId: string, pair: { entityType: string; relationshipType: string }, deps: DegreeStageDeps): Promise<Verdict> {
  let page;
  try {
    page = await run({ traceId, sourceId: source.id, templateId: DEGREE_PROBE_ID, params: pair, limit: 1 });
  } catch (error) {
    if (isRefused(error)) return COULD_NOT_TELL('refused');
    if (error instanceof AppError && error.code === 'QUERY_TIMEOUT') return COULD_NOT_TELL('timeout');
    throw error;
  }
  const [item] = page.items;
  const parsed = degreeProbeItemSchema.safeParse(item);
  if (page.hasMore || page.items.length !== 1 || item === undefined || !parsed.success) {
    // the type of each column, never a value
    deps.logger?.warn({ event: 'source.degree_unreadable', sourceId: source.id, columnTypes: item !== undefined && isUnreadable(item) ? [item.unreadable] : [] }, 'source degree probe answer could not be read');
    return COULD_NOT_TELL('unreadable');
  }
  return judgePlan(parsed.data.operators);
}

/**
 * Asks the server, for each entity type that has a mapped relationship, how it answers a count of neighbors, with the degree probe: one read after another.
 * A refusal ends the stage; a probe is started only while the stage is within its window.
 */
export async function checkDegrees(source: SourceModel, run: CheckRun, traceId: string, foundOn: string, deps: DegreeStageDeps): Promise<DegreeChecks> {
  const started = deps.clock();
  const byType = new Map<string, DegreeType>();
  let refused = false;
  for (const pair of degreePairs(source)) {
    let verdict: Verdict;
    if (refused) verdict = COULD_NOT_TELL('refused');
    else if (deps.clock() - started >= DEGREE_START_WINDOW_MS) verdict = COULD_NOT_TELL('skipped');
    else {
      verdict = await probe(source, run, traceId, pair, deps);
      refused = verdict.basis === 'refused';
    }
    const known = byType.get(pair.entityType);
    if (known === undefined) byType.set(pair.entityType, { entityType: pair.entityType, ...verdict, relationshipTypes: [pair.relationshipType] });
    else {
      // the worst pair gives the result and, among equals, the first in probe order gives the basis
      const worse = SEVERITY[verdict.result] > SEVERITY[known.result];
      byType.set(pair.entityType, { ...known, ...(worse ? verdict : {}), relationshipTypes: [...known.relationshipTypes, pair.relationshipType] });
    }
  }
  const types = [...byType.values()];
  if (types.length === 0) return NOT_RUN_DEGREES;
  const warnings = types.flatMap((entry) => warningOf(entry) ?? []);
  return { status: warnings.length === 0 ? 'pass' : 'warn', foundOn, types, warnings };
}
