import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultsLines, judge, observe, runDefaults } from './assistant-defaults.js';
import { loadAssistantSets } from './assistant-run.js';
import { cleanUpTemporary } from './sets.js';
import { cleanUp, hooksWith, scratch } from './testing/hooks.js';

afterAll(() => {
  cleanUp();
  cleanUpTemporary();
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKS = join(ROOT, 'domain-packs');

describe('the figures of an observation', () => {
  it('gives the maximum and the nearest-rank p95 and p99', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(observe(values)).toEqual({ count: 100, max: 100, p95: 95, p99: 99 });
    expect(observe([7])).toEqual({ count: 1, max: 7, p95: 7, p99: 7 });
    expect(observe([])).toEqual({ count: 0, max: 0, p95: 0, p99: 0 });
  });
});

describe('the verdict on a limit', () => {
  const limit = { default: 10, highest: 20 };
  it('is inside up to 80% of the default, close above it, and over past the default', () => {
    expect(judge('x', observe([8]), limit)).toMatchObject({ verdict: 'inside' });
    expect(judge('x', observe([9]), limit)).toMatchObject({ verdict: 'close', proposed: 12 });
    expect(judge('x', observe([10]), limit)).toMatchObject({ verdict: 'close' });
    expect(judge('x', observe([11]), limit)).toMatchObject({ verdict: 'over', proposed: 14 });
  });
  it('keeps a proposal within the highest value and says when nothing was measured', () => {
    expect(judge('x', observe([19]), limit)).toMatchObject({ verdict: 'over', proposed: 20 });
    expect(judge('x', observe([]), limit, 'stand-in')).toMatchObject({ verdict: 'not measured', reason: 'stand-in' });
  });
});

describe('the token figures', () => {
  it('judge the largest single call of a turn, not the mean, and say a router request is a mean', async () => {
    const sets = await loadAssistantSets(PACKS, hooksWith(() => ({ failure: 'timeout' })));
    const folder = scratch();
    const runRecord = join(folder, 'run-record.json');
    const loop = join(folder, 'loop-cost-record.json');
    writeFileSync(runRecord, JSON.stringify({ outcomes: [] }));
    writeFileSync(loop, JSON.stringify({ rows: [{ name: 'a', on: { total: 5, inputTokens: 5000, outputTokens: 500, stepCalls: 2, steps: 2, maxInputTokens: 30_000, maxOutputTokens: 100, rows: 1 } }] }));
    const result = runDefaults(sets, { runRecord, loopCost: loop, force: false }, hooksWith(() => ({ failure: 'timeout' })));
    const text = result.lines.join('\n');
    expect(text).toMatch(/input tokens of a call.*max 30000.*over/);
    expect(text).toMatch(/output tokens of a call.*max 100.*inside/);
    expect(text).toContain('mean of its calls');
  });
});

describe('the defaults command', () => {
  const outcome = (name: string, calls: number, inputTokens: number, outputTokens: number) => ({ name, status: 'ok', calls, inputTokens, outputTokens });
  const on = (total: number, steps: number, maxInputTokens = 1000, maxOutputTokens = 100) => ({ total, inputTokens: 1000 * total, outputTokens: 100 * total, stepCalls: steps, steps, maxInputTokens, maxOutputTokens, rows: 1 });

  it('prints each limit with its verdict, proposes only for close or over, and changes no file of the repository', async () => {
    const sets = await loadAssistantSets(PACKS, hooksWith(() => ({ failure: 'timeout' })));
    const folder = scratch();
    const runRecord = join(folder, 'run-record.json');
    const loop = join(folder, 'loop-cost-record.json');
    writeFileSync(runRecord, JSON.stringify({ outcomes: [outcome('a', 1, 2000, 100), outcome('b', 2, 6000, 300), outcome('c', 0, 0, 0)] }));
    writeFileSync(loop, JSON.stringify({ rows: [{ name: 'a', on: on(2, 1) }, { name: 'b', on: on(6, 5) }] }));
    const before = readdirSync(PACKS, { recursive: true }).map((entry) => `${String(entry)}:${statSync(join(PACKS, String(entry))).mtimeMs}`);
    const out = join(folder, 'out');
    const result = runDefaults(sets, { runRecord, loopCost: loop, out, force: false }, hooksWith(() => ({ failure: 'timeout' })));
    const text = result.lines.join('\n');
    expect(text).toContain('tool steps a turn');
    expect(text).toMatch(/tool steps a turn.*max 5.*over/);
    expect(text).toContain('rows a turn');
    expect(text).toContain('not measured');
    expect(result.code).toBe(1);
    expect(existsSync(join(out, 'defaults-record.json'))).toBe(true);
    expect(statSync(join(out, 'defaults-record.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(PACKS, { recursive: true }).map((entry) => `${String(entry)}:${statSync(join(PACKS, String(entry))).mtimeMs}`)).toEqual(before);
    expect(defaultsLines([]).length).toBe(0);
    mkdirSync(join(folder, 'unused'), { recursive: true });
    expect(readFileSync(runRecord, 'utf8')).toContain('outcomes');
  });
});
