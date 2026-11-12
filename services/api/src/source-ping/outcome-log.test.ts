import { describe, expect, it } from 'vitest';
import type { FailureReason } from '../source-test/reasons.js';
import { createPingOutcomeLog } from './outcome-log.js';
import type { PingResult } from './ping.js';

interface Line {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
}

function recorder() {
  const lines: Line[] = [];
  const logger = {
    info: (fields: object) => void lines.push({ level: 'info', fields: { ...fields } }),
    warn: (fields: object) => void lines.push({ level: 'warn', fields: { ...fields } }),
  };
  return { lines, log: createPingOutcomeLog(logger) };
}

const reached = (sourceId = 'alpha'): PingResult => ({ sourceId, previous: 'unknown', current: 'reachable', reason: null, failure: null, skipped: false, cause: null, recovered: false, startedAt: 1 });
const failed = (failure: FailureReason, sourceId = 'alpha'): PingResult => ({ ...reached(sourceId), current: 'unreachable', reason: `sentence of ${failure}`, failure });
const skipped = (cause: string, sourceId = 'alpha'): PingResult => ({ ...reached(sourceId), skipped: true, cause });

describe('the ping outcome log', () => {
  it('writes an info line for the first reached tick and nothing for the same outcome again', () => {
    const { lines, log } = recorder();
    log([reached()]);
    log([reached()]);
    expect(lines).toEqual([{ level: 'info', fields: { event: 'source.ping_outcome', sourceId: 'alpha', outcome: 'reachable' } }]);
  });

  it.each(['unreachable', 'authentication', 'credentials', 'database', 'refused', 'timeout'] as const)('writes a warn line with the failure kind %s once, and again only when the kind changes', (failure) => {
    const { lines, log } = recorder();
    log([failed(failure)]);
    log([failed(failure)]);
    expect(lines).toEqual([{ level: 'warn', fields: { event: 'source.ping_outcome', sourceId: 'alpha', outcome: 'unreachable', failure } }]);
    log([failed(failure === 'timeout' ? 'refused' : 'timeout')]);
    expect(lines).toHaveLength(2);
  });

  it('writes a line again when a failed source is reached and when it fails again', () => {
    const { lines, log } = recorder();
    log([failed('authentication')]);
    log([reached()]);
    log([failed('authentication')]);
    expect(lines.map((line) => [line.level, line.fields['outcome']])).toEqual([['warn', 'unreachable'], ['info', 'reachable'], ['warn', 'unreachable']]);
  });

  it('writes info on the first skipped tick, warn once on the second in a row, and nothing on the third', () => {
    const { lines, log } = recorder();
    const cause = 'SOURCE_UNAVAILABLE:pool-full';
    for (let tick = 0; tick < 3; tick += 1) log([skipped(cause)]);
    expect(lines).toEqual([
      { level: 'info', fields: { event: 'source.ping_outcome', sourceId: 'alpha', outcome: 'skipped', cause } },
      { level: 'warn', fields: { event: 'source.ping_outcome', sourceId: 'alpha', outcome: 'skipped', cause } },
    ]);
  });

  it('counts skipped ticks of one source together whatever their cause, so an alternating cause writes no more than two lines', () => {
    const { lines, log } = recorder();
    for (const cause of ['SOURCE_UNAVAILABLE:pool-full', 'SOURCE_UNAVAILABLE:closed', 'SOURCE_UNAVAILABLE:pool-full', 'SOURCE_UNAVAILABLE:closed']) log([skipped(cause)]);
    expect(lines.map((line) => line.level)).toEqual(['info', 'warn']);
  });

  it('starts the skipped count again after a tick of another outcome', () => {
    const { lines, log } = recorder();
    log([skipped('UNKNOWN')]);
    log([reached()]);
    log([skipped('UNKNOWN')]);
    expect(lines.map((line) => [line.level, line.fields['outcome']])).toEqual([['info', 'skipped'], ['info', 'reachable'], ['info', 'skipped']]);
  });

  it('keeps the outcome of each source apart', () => {
    const { lines, log } = recorder();
    log([reached('alpha'), failed('authentication', 'beta')]);
    log([reached('alpha'), failed('authentication', 'beta')]);
    expect(lines.map((line) => [line.fields['sourceId'], line.fields['outcome']])).toEqual([['alpha', 'reachable'], ['beta', 'unreachable']]);
  });

  it('writes only fixed tags and the source ID, never the sentence of the failure', () => {
    const { lines, log } = recorder();
    log([failed('authentication'), skipped('UNKNOWN', 'beta')]);
    expect(JSON.stringify(lines)).not.toContain('sentence of');
    for (const line of lines) expect(Object.keys(line.fields).sort()).toEqual(expect.arrayContaining(['event', 'outcome', 'sourceId']));
  });
});
