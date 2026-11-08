import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DbHitCause } from '../benchmark/db-hit-cause.js';
import type { ReadSet } from '../benchmark/plan.js';

/** What one page cost: the wall time of the gate call, the rows and the serialized size of the answer, and, for a page that was profiled, the db hits of its statement. */
export interface PageCost {
  readonly size: number;
  readonly readSet: ReadSet;
  readonly position: string;
  readonly ms: number;
  readonly edges: number;
  readonly bytes: number;
  /** Taken from one profile of the page's statement, on a separate session, straight after the timed read; absent for a page that was not profiled. */
  readonly dbHits?: number;
}

export interface CostRecord {
  readonly neo4j: { readonly version: string; readonly edition: string };
  readonly commit: string;
  readonly date: string;
  readonly dbHitCause: DbHitCause;
  readonly pages: readonly PageCost[];
}

/** The environment variable that names the file the record is written to. */
export const RECORD_VARIABLE = 'NBX_SUPERNODE_RECORD';

const pageOf = (page: PageCost): PageCost => ({
  size: page.size,
  readSet: page.readSet,
  position: page.position,
  ms: Math.round(page.ms * 10) / 10,
  edges: page.edges,
  bytes: page.bytes,
  ...(page.dbHits === undefined ? {} : { dbHits: page.dbHits }),
});

/** The text of a record: the same data always gives the same text, and a page that was not profiled has no db hits. */
export function serializeCostRecord(record: CostRecord): string {
  return `${JSON.stringify({ neo4j: record.neo4j, commit: record.commit, date: record.date, dbHitCause: record.dbHitCause, pages: record.pages.map(pageOf) }, null, 2)}\n`;
}

/** Writes the record to the file the variable names and returns its path; with no variable set it writes nothing and returns undefined. */
export function writeCostRecord(record: CostRecord, environment: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const path = environment[RECORD_VARIABLE];
  if (path === undefined || path === '') return undefined;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeCostRecord(record));
  return path;
}
