import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the entry script of the command', () => {
  it('runs the built command with the enterprise hooks: a stub run of a view exits 0 with no key in the environment and prints its report', () => {
    const entry = resolve(import.meta.dirname, '../../entry/summary-eval-entry.mjs');
    const run = spawnSync(process.execPath, [entry, '--stub', '--views', 'aml-cycle'], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('aml-cycle [aml]: ok');
    const refused = spawnSync(process.execPath, [entry, '--no-such-flag'], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
    expect(refused.status).toBe(2);
  });
});
