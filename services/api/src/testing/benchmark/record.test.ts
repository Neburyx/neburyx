import { describe, expect, it } from 'vitest';
import type { Cell } from './measure.js';
import { isLowerBound, renderRecord, verdictOf, type RunData } from './record.js';

const cell = (size: number, readSet: Cell['readSet'], position: string, p95: number, failures = 0): Cell => ({ size, readSet, position, rows: size, repeated: 0, samples: 30, failures, p50: p95 / 2, p95, max: p95 + 1 });
const data = (p95: number): RunData => ({
  date: '2026-11-07',
  neo4j: { version: '5.26.0', edition: 'enterprise' },
  serverIsLoopback: true,
  cold: { ms: 400, failed: false },
  stopped: [],
  profiles: [{ size: 100_000, readSet: 'all', position: '90%', branches: 11, dbHits: 1234567, rootRows: 26, availableMs: 40, consumedMs: 41, indexSeek: true }],
  cells: [cell(1000, 'dated', 'first', 5), cell(100_000, 'dated', 'first', 10), cell(100_000, 'all', '90%', p95)],
  previews: [{ size: 100_000, quality: 'lowerBound / exact', samples: 30, failures: 0, p50: 1, p95: 2, max: 3 }],
});

describe('the record of the supernode benchmark', () => {
  it('says the target is met when every cell at 100,000 is under 3 s', () => {
    expect(verdictOf(data(2999).cells).met).toBe(true);
    const text = renderRecord(data(2999));
    expect(text).toContain('**Target met.**');
    expect(text).not.toContain('Target not met');
  });

  it('says the target is not met, and where, when a cell at 100,000 reaches 3 s', () => {
    const verdict = verdictOf(data(3000).cells);
    expect(verdict.met).toBe(false);
    expect(verdict.overTarget).toEqual([{ readSet: 'all', position: '90%', p95: 3000 }]);
    const text = renderRecord(data(3000));
    expect(text).toContain('**Target not met.**');
    expect(text).toContain('all at 90%');
    expect(text).toContain('cheaper read');
  });

  it('judges only the cells at 100,000', () => {
    expect(verdictOf([cell(1000, 'dated', 'first', 9999), cell(100_000, 'dated', 'first', 10)]).met).toBe(true);
    expect(() => verdictOf([cell(1000, 'dated', 'first', 1)])).toThrow('100,000');
  });

  it('states the work of a page in the words of the specification and holds no address or login', () => {
    const text = renderRecord(data(10));
    expect(text).toContain('matches every relationship of the anchor for the asked type before it sorts and cuts');
    expect(text).not.toMatch(/bolt|neo4j:\/\/|password|localhost|127\.0\.0\.1/i);
  });

  it('shows a p95 that rests on failed calls as "at least", and never as exact', () => {
    expect(isLowerBound(cell(100_000, 'all', '90%', 5000, 1))).toBe(false);
    expect(isLowerBound(cell(100_000, 'all', '90%', 5000, 2))).toBe(true);
    const withFailures: RunData = { ...data(5000), cells: [cell(100_000, 'all', '90%', 5000, 6)] };
    const text = renderRecord(withFailures);
    expect(text).toContain('at least 5000');
    expect(text).toContain('**Target not met.**');
  });

  it('lists the positions a walk did not reach', () => {
    const text = renderRecord({ ...data(10), stopped: [{ size: 100_000, readSet: 'all', atRow: 4000, notReached: ['50%', '90%'] }] });
    expect(text).toContain('all at 100,000: stopped at row 4,000; not reached: 50%, 90%.');
  });

  it('says which commit the run exercised, and the note that goes with it', () => {
    expect(renderRecord(data(10))).not.toContain('Run on the code of commit');
    const text = renderRecord({ ...data(10), commit: 'abc1234', note: 'before a later change' });
    expect(text).toContain('- Run on the code of commit abc1234, before a later change.');
  });

  it('says that 2026.x was not measured, and what the server address was without printing it', () => {
    const text = renderRecord(data(10));
    expect(text).toContain('Neo4j 2026.x');
    expect(text).toContain('is a loopback address');
  });

  it('does not say met when a p95 under 3 s rests on failed calls', () => {
    const verdict = verdictOf([cell(100_000, 'all', '90%', 80, 10)]);
    expect(verdict.met).toBe(false);
    expect(verdict.lowerBound).toEqual([{ readSet: 'all', position: '90%' }]);
    const text = renderRecord({ ...data(10), cells: [cell(100_000, 'all', '90%', 80, 10)] });
    expect(text).toContain('**Target not shown.**');
    expect(text).not.toContain('**Target met.**');
  });

  it('does not say met when a walk at 100,000 stopped before its deep positions', () => {
    const stopped = [{ size: 100_000, readSet: 'all' as const, atRow: 0, notReached: ['50%', '90%'] }];
    expect(verdictOf([cell(100_000, 'all', 'first', 10)], stopped).met).toBe(false);
    expect(verdictOf([cell(100_000, 'all', 'first', 10)], [{ ...stopped[0], size: 10_000 }]).met).toBe(true);
    expect(renderRecord({ ...data(10), stopped })).toContain('**Target not shown.**');
  });

  it('names the heaviest statement when the target is not met, and cites the interactive latency target', () => {
    expect(renderRecord(data(3000))).toContain('the heaviest statement at 100,000 is all at 90%, 1,234,567 db hits over 11 branches');
    expect(renderRecord(data(10))).toContain('TAS §14');
  });

  it('leaves out private plan IDs and states a remote server only when the server is not loopback', () => {
    expect(renderRecord(data(10))).not.toMatch(/EP-\d/);
    expect(renderRecord(data(10))).toContain('a remote server');
    expect(renderRecord({ ...data(10), serverIsLoopback: false })).not.toContain('a remote server');
  });
});
