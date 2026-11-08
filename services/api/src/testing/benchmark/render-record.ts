import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { resolve } from 'node:path';
import { dbHitCauseFor } from './db-hit-cause.js';
import { renderRecord, type RunData } from './record.js';

const STORED = z.looseObject({ neo4j: z.looseObject({ version: z.string() }) });

/**
 * Renders `supernode.md` again from the stored data of the last run, with no server: what is known of the extra db hits is set in the data, for the series the run was on, and both files are written.
 * The text says it was rendered from the stored run and not from a new run.
 */
export function renderStored(directory: string): RunData {
  const parsed = STORED.safeParse(JSON.parse(readFileSync(resolve(directory, 'supernode.json'), 'utf8')));
  if (!parsed.success) throw new Error('supernode.json is not the data of a run: it holds no server version');
  // the rest of the file is what renderRecord wrote there; only the version is needed to choose the cause
  const data = { ...(parsed.data as unknown as RunData), dbHitCause: dbHitCauseFor(parsed.data.neo4j.version) };
  writeFileSync(resolve(directory, 'supernode.md'), renderRecord(data, { fromStored: true }));
  writeFileSync(resolve(directory, 'supernode.json'), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}
