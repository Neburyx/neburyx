import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbHitCauseFor } from './db-hit-cause.js';
import { measureCold, measurePreview, measureReadSet, type Cell, type PreviewCell } from './measure.js';
import { READ_SETS, SIZES } from './plan.js';
import { measureCancel } from './cancel-measure.js';
import { profileReadSet, type Profile } from './profile.js';
import { renderRecord, type RunData, type Stopped } from './record.js';
import { startRig, stopRig, type Rig } from './rig.js';

const RECORD_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/benchmarks');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let rig: Rig | undefined;

beforeAll(async () => {
  rig = await startRig();
}, 3_600_000);

afterAll(async () => {
  await stopRig(rig);
});

describe('the supernode benchmark', () => {
  it('measures a page of the paged expand and the degree preview at each size, and writes the record', async () => {
    if (rig === undefined) throw new Error('the rig did not start');
    const { server, parts, positionOf } = rig;
    const cold = await measureCold(parts.gate, SIZES[0]);
    const cells: Cell[] = [];
    const previews: PreviewCell[] = [];
    const profiles: Profile[] = [];
    const stopped: Stopped[] = [];
    for (const size of SIZES) {
      previews.push(await measurePreview(parts.gate, size));
      for (const readSet of READ_SETS) {
        const result = await measureReadSet(parts.gate, size, readSet, async (label, cursor) => {
          const position = cursor === undefined ? undefined : positionOf(cursor);
          if (cursor !== undefined && position === undefined) throw new Error(`no position was recorded for the cursor at ${label} of ${readSet} at ${size}`);
          profiles.push(await profileReadSet(server, size, readSet, label, position));
        });
        cells.push(...result.cells);
        if (result.stopped !== undefined) stopped.push({ size, readSet, ...result.stopped });
        process.stdout.write(`${size} ${readSet}: ${result.cells.map((cell) => `${cell.position} p95 ${cell.p95.toFixed(0)} ms`).join(', ')}${result.stopped === undefined ? '' : ` (stopped at row ${result.stopped.atRow})`}\n`);
      }
    }
    const data: RunData = {
      date: new Date().toISOString().slice(0, 10),
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(),
      neo4j: { version: server.version, edition: rig.edition },
      serverIsLoopback: LOOPBACK_HOSTS.has(new URL(server.boltUri.replace(/^neo4j/, 'bolt')).hostname),
      cold,
      cells,
      stopped,
      previews,
      profiles,
      dbHitCause: dbHitCauseFor(server.version),
      cancel: await measureCancel(rig),
    };
    mkdirSync(RECORD_DIRECTORY, { recursive: true });
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.json'), `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.md'), renderRecord(data));
    expect(cells.length).toBeGreaterThan(0);
  }, 28_800_000);
});
