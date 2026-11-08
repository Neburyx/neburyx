import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderRecord, type RunData } from './record.js';
import { measureRefined } from './refined.js';
import { startRig, stopRig, type Rig } from './rig.js';

const RECORD_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/benchmarks');
/** The anchors of this run: the cost of a filtered or ranked page does not depend on its depth, so two sizes show how it grows. */
const SIZES = [10_000, 100_000];

let rig: Rig | undefined;

beforeAll(async () => {
  rig = await startRig({ sizes: SIZES });
}, 3_600_000);

afterAll(async () => {
  await stopRig(rig);
});

describe('the section of the supernode record on filtered, ranked and counted reads', () => {
  it('measures the cells and adds them to the stored record, which is otherwise kept as it is', async () => {
    if (rig === undefined) throw new Error('the rig did not start');
    const cells = [];
    for (const size of SIZES) cells.push(...(await measureRefined(rig.server, rig.parts.gate, size)));
    const stored = JSON.parse(readFileSync(resolve(RECORD_DIRECTORY, 'supernode.json'), 'utf8')) as RunData;
    const data: RunData = { ...stored, refined: { date: new Date().toISOString().slice(0, 10), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(), neo4j: { version: rig.server.version, edition: rig.edition }, cells } };
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.json'), `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.md'), renderRecord(data, { fromStored: true }));
    expect(cells.length).toBeGreaterThan(0);
  }, 7_200_000);
});
