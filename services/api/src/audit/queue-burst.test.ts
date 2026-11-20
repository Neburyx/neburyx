import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { percentile, proposed, runBurst, smallestSizeWithoutDrops, verdictOf, writeMeasureRecord } from '../testing/burst-measure.js';
import { BUDGET_DEFAULTS } from '../mapping/budgets.js';
import { AUDIT_QUEUE_SIZE_BOUNDS, AUDIT_RETRY_LIMIT_BOUNDS, AUDIT_RETRY_WAIT_BOUNDS, AUDIT_WRITE_TIMEOUT_BOUNDS, type AuditSettings } from './settings.js';

const DEFAULTS: AuditSettings = { queueSize: AUDIT_QUEUE_SIZE_BOUNDS.default, retryLimit: AUDIT_RETRY_LIMIT_BOUNDS.default, retryWaitMs: AUDIT_RETRY_WAIT_BOUNDS.default, writeTimeoutMs: AUDIT_WRITE_TIMEOUT_BOUNDS.default };
/** One person at the product's request rate, and the most events a turn emits at the default calls (5 model calls, each audited), tool reads (4, each a gate read) and one closing event: 5 + 4 + 1 = 10, plus one for the view read, 11. The figure is an upper bound that the story's measurements may replace. */
const ONE_PERSON = { people: 1, requestsPerPerson: BUDGET_DEFAULTS.requestsPerMinute, eventsPerTurn: 11 };

describe('the audit queue under a burst against a sink that stalls for the whole write time limit', () => {
  it('accounts for every event: written, failed, dropped or still queued, with no event lost uncounted', async () => {
    const result = await runBurst(DEFAULTS, ONE_PERSON);
    expect(result.emitted).toBe(BUDGET_DEFAULTS.requestsPerMinute * 11);
    const inWrite = result.emitted - (result.written + result.failed + result.dropped + result.queued);
    expect(inWrite).toBeGreaterThanOrEqual(0);
    expect(inWrite).toBeLessThanOrEqual(1);
  }, 30_000);

  it('drops events at the default size when the stall lasts the window, and counts each drop', async () => {
    const result = await runBurst(DEFAULTS, ONE_PERSON);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.written).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.attempts).toBeLessThanOrEqual(result.failed + 1);
  }, 30_000);

  it('finds the smallest size that drops none, and a size one below it drops', async () => {
    const size = await smallestSizeWithoutDrops(DEFAULTS, ONE_PERSON, AUDIT_QUEUE_SIZE_BOUNDS.max);
    expect(size).toBeDefined();
    expect(size).toBeGreaterThan(DEFAULTS.queueSize);
    expect((await runBurst({ ...DEFAULTS, queueSize: (size ?? 1) - 1 }, ONE_PERSON)).dropped).toBeGreaterThan(0);
  }, 30_000);

  it('accounts for a single event against the stalled sink', async () => {
    const result = await runBurst({ ...DEFAULTS, queueSize: 1 }, { people: 1, requestsPerPerson: 1, eventsPerTurn: 1 });
    expect(result.emitted).toBe(1);
    expect(result.dropped).toBe(0);
  });
});

describe('the verdicts and the figures', () => {
  it('is inside up to 80% of a limit, close above it and over past it', () => {
    expect([verdictOf(80, 100), verdictOf(81, 100), verdictOf(100, 100), verdictOf(101, 100)]).toEqual(['inside', 'close', 'close', 'over']);
  });
  it('takes the nearest rank and proposes a 25% margin within the highest value', () => {
    expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.99)).toBe(99);
    expect([proposed(100, 1000), proposed(900, 1000)]).toEqual([125, 1000]);
  });
});

describe('the record of a measurement', () => {
  const fresh = (): string => mkdtempSync(join(tmpdir(), 'measure-'));
  it('is written outside every git working tree to a file for its owner only', () => {
    const folder = join(fresh(), 'out');
    const file = writeMeasureRecord(folder, 'burst.json', { ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ok: true });
  });
  it('makes an existing file owner-only, and refuses a folder inside a working tree, a folder others can reach and a link', () => {
    const folder = fresh();
    const existing = join(folder, 'burst.json');
    writeFileSync(existing, 'old', { mode: 0o644 });
    chmodSync(existing, 0o644);
    expect(statSync(writeMeasureRecord(folder, 'burst.json', {})).mode & 0o777).toBe(0o600);
    expect(() => writeMeasureRecord(join(process.cwd(), 'record-out'), 'x.json', {})).toThrow('inside a git working tree');
    const open = fresh();
    chmodSync(open, 0o755);
    expect(() => writeMeasureRecord(open, 'x.json', {})).toThrow('reached by others');
    const link = join(fresh(), 'link');
    symlinkSync(folder, link);
    expect(() => writeMeasureRecord(link, 'x.json', {})).toThrow('a link');
  });
});
