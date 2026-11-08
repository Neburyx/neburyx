import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureCancel } from './cancel-measure.js';
import { renderRecord, type RunData } from './record.js';
import { startRig, stopRig, type Rig } from './rig.js';

const RECORD_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/benchmarks');

let rig: Rig | undefined;

beforeAll(async () => {
  rig = await startRig();
}, 3_600_000);

afterAll(async () => {
  await stopRig(rig);
});

describe('the cancel measurement', () => {
  it('aborts a running expand at each size, records how long its transaction stays on the server, and adds the section to the record', async () => {
    if (rig === undefined) throw new Error('the rig did not start');
    const cancel = await measureCancel(rig);
    const stored = JSON.parse(readFileSync(resolve(RECORD_DIRECTORY, 'supernode.json'), 'utf8')) as RunData;
    const data: RunData = { ...stored, cancel };
    mkdirSync(RECORD_DIRECTORY, { recursive: true });
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.json'), `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(resolve(RECORD_DIRECTORY, 'supernode.md'), renderRecord(data));
    expect(cancel.cells.every((cell) => cell.notGone === 0)).toBe(true);
    expect(cancel.cells.at(-1)?.gone).toBeDefined();
  });
});
