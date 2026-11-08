import { describe, expect, it } from 'vitest';
import { NOT_CHECKED_SINCE_START } from '../source-test/reasons.js';
import { decideSourceState, type SourceHashes, type StoredCheck } from './decide.js';

const SOURCE: SourceHashes = { identityHash: 'identity-1', configHash: 'config-1' };
const at = (minute: number, second = 0): string => new Date(Date.UTC(2026, 10, 2, 10, minute, second)).toISOString();

function check(id: string, checkedAt: string, state: string, overrides: Partial<StoredCheck> = {}): StoredCheck {
  return { id, checkedAt, identityHash: SOURCE.identityHash, configHash: SOURCE.configHash, reachedSource: true, state, stateReason: state === 'connected' ? null : `${state} reason`, ...overrides };
}

function orderings<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe('deciding the shown state of a source', () => {
  it('is the newest qualifying check of any copy, whichever order the checks come in', () => {
    const checks = [check('a', at(1), 'connected'), check('b', at(3), 'degraded')];
    for (const order of orderings(checks)) {
      expect(decideSourceState(order, SOURCE)).toEqual({ state: 'degraded', stateReason: 'degraded reason', decidedBy: 'b' });
    }
  });

  it('breaks a tie of time by the larger check ID, in either order', () => {
    const checks = [check('0001-a', at(2), 'connected'), check('0001-b', at(2), 'degraded')];
    for (const order of orderings(checks)) expect(decideSourceState(order, SOURCE).decidedBy).toBe('0001-b');
  });

  it('compares times as times, not as text', () => {
    const early = check('z', '2026-11-02T10:00:00.000Z', 'connected');
    const late = check('a', '2026-11-02T10:00:00.5Z', 'degraded');
    expect(decideSourceState([early, late], SOURCE).decidedBy).toBe('a');
  });

  it('skips a newer check that did not reach the source', () => {
    const checks = [check('a', at(1), 'connected'), check('b', at(5), 'unavailable', { reachedSource: false })];
    expect(decideSourceState(checks, SOURCE)).toEqual({ state: 'connected', stateReason: null, decidedBy: 'a' });
  });

  it('skips a newer check of another connection, of another mapping, or with no mapping hash', () => {
    const older = check('a', at(1), 'connected');
    for (const other of [{ identityHash: 'identity-2' }, { configHash: 'config-2' }, { configHash: null }, { identityHash: null }]) {
      expect(decideSourceState([older, check('b', at(9), 'degraded', other)], SOURCE).decidedBy).toBe('a');
    }
  });

  it('is not checked when no check qualifies, and says so with the fixed reason', () => {
    expect(decideSourceState([], SOURCE)).toEqual({ state: 'unknown', stateReason: NOT_CHECKED_SINCE_START, decidedBy: null });
    expect(decideSourceState([check('a', at(1), 'connected', { reachedSource: false })], SOURCE).decidedBy).toBeNull();
  });

  it('reads a row with no state as unknown', () => {
    expect(decideSourceState([check('a', at(1), 'connected', { state: null, stateReason: null })], SOURCE)).toEqual({ state: 'unknown', stateReason: null, decidedBy: 'a' });
  });

  it('gives every copy the same answer at every step of an interleaved run, and repeating changes nothing', () => {
    // three copies; the third's start did not settle, so it stores nothing; each copy reads the same rows with the same hashes
    const stored: StoredCheck[] = [];
    const steps: readonly (StoredCheck | undefined)[] = [
      undefined,
      check('01', at(1), 'connected'),
      undefined,
      check('02', at(2), 'degraded'),
      check('03', at(2), 'connected'),
      check('04', at(4), 'unavailable', { reachedSource: false }),
      check('05', at(3), 'degraded', { configHash: 'config-2' }),
    ];
    const expected = ['unknown', 'connected', 'connected', 'degraded', 'connected', 'connected', 'connected'];
    steps.forEach((step, index) => {
      if (step !== undefined) stored.push(step);
      const views = [0, 1, 2].map((copy) => decideSourceState(copy === 1 ? [...stored].reverse() : stored, SOURCE));
      expect(views.map((view) => view.state)).toEqual([expected[index], expected[index], expected[index]]);
      expect(decideSourceState(stored, SOURCE)).toEqual(views[0]);
    });
  });
});
