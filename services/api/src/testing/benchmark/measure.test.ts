import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import type { Gate } from '../../gate/types.js';
import { checkShape, measureReadSet, timedWindow } from './measure.js';
import { POSITION_FAILURES, SAMPLES_PER_POSITION, WALK_FAILURES } from './plan.js';

const failingGate = (): { readonly gate: Gate; readonly calls: () => number } => {
  let calls = 0;
  const gate = {
    run: () => {
      calls += 1;
      return Promise.reject(new AppError('QUERY_TIMEOUT'));
    },
  } as unknown as Gate;
  return { gate, calls: () => calls };
};

describe('the measurement of a read set', () => {
  it('keeps a failing position as failures after five in a row, without asking for the rest', async () => {
    const { gate, calls } = failingGate();
    const { samples } = await timedWindow(gate, 1000, 'dated', 'first', undefined);
    expect(samples).toHaveLength(SAMPLES_PER_POSITION);
    expect(samples.every((sample) => sample.failed)).toBe(true);
    expect(calls()).toBe(POSITION_FAILURES);
  });

  it('ends the read set where the walk cannot pass, and says which positions were not reached', async () => {
    const { gate } = failingGate();
    const result = await measureReadSet(gate, 1000, 'dated');
    expect(result.cells.map((cell) => [cell.position, cell.failures])).toEqual([['first', SAMPLES_PER_POSITION]]);
    expect(result.stopped).toEqual({ atRow: 0, notReached: ['10%', '50%', '90%'] });
    expect(WALK_FAILURES).toBeGreaterThan(POSITION_FAILURES);
  });

  it('does not count a refused cursor or request as a slow answer', async () => {
    for (const code of ['CURSOR_INVALIDATED', 'INVALID_REQUEST', 'QUERY_BUDGET_EXCEEDED'] as const) {
      const gate = { run: () => Promise.reject(new AppError(code)) } as unknown as Gate;
      await expect(measureReadSet(gate, 1000, 'dated')).rejects.toThrow(code);
    }
  });

  it('does not hide a fault of the benchmark behind a gate error', async () => {
    const gate = { run: () => Promise.reject(new Error('broken')) } as unknown as Gate;
    await expect(measureReadSet(gate, 1000, 'dated')).rejects.toThrow('broken');
  });

  it('refuses a page that is short before the last, or a last page with a cursor', () => {
    const edges = Array.from({ length: 3 }, () => ({})) as never;
    expect(() => checkShape({ edges, hasMore: true, nextCursor: 'c' }, 25, 'test')).toThrow('3 of 25');
    expect(() => checkShape({ edges, hasMore: false, nextCursor: 'c' }, 3, 'test')).toThrow('last page');
    expect(() => checkShape({ edges, hasMore: false, nextCursor: undefined }, 25, 'test')).not.toThrow();
  });
});
