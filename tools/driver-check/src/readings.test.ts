import { describe, expect, it } from 'vitest';
import { samples } from './fixtures.js';
import { observationAt, readClose, readTimeout, type CallEnd, type Sample } from './readings.js';

const raisedAt1100: CallEnd = { kind: 'raised', atMs: 1100, errorClass: 'Neo4jError', code: 'Neo.ClientError.Transaction.TransactionTimedOut' };
const returnedAt400: CallEnd = { kind: 'returned', atMs: 400, rows: 1 };

describe('observationAt', () => {
  it('is not observable without a look close enough', () => {
    expect(observationAt([], 1000)).toBe('not observable');
    expect(observationAt([{ sentMs: 0, atMs: 0, state: 'running' }], 5000)).toBe('not observable');
  });

  it('does not call a transaction gone before it was ever seen running', () => {
    expect(observationAt([{ sentMs: 0, atMs: 0, state: 'absent' }], 100)).toBe('not observable');
  });

  it('treats an unreadable list and a transaction that is ending as not observable', () => {
    expect(observationAt([{ sentMs: 0, atMs: 0, state: 'unreadable' }], 100)).toBe('not observable');
    const ending: Sample[] = [{ sentMs: 0, atMs: 0, state: 'running' }, { sentMs: 500, atMs: 500, state: 'ending' }];
    expect(observationAt(ending, 600)).toBe('not observable');
  });

  it('counts how old a look is from when it was sent, not from when it was answered', () => {
    const slow: Sample[] = [{ sentMs: 0, atMs: 1800, state: 'running' }];
    expect(observationAt(slow, 1900)).toBe('not observable');
  });

  it('keeps an open transaction with no query apart from a running one', () => {
    expect(observationAt([{ sentMs: 0, atMs: 0, state: 'idle' }], 100)).toBe('idle');
  });

  it('ignores a look whose answer arrived after the moment asked about', () => {
    const slow: Sample[] = [
      { sentMs: 200, atMs: 300, state: 'running' },
      { sentMs: 900, atMs: 1500, state: 'absent' },
    ];
    expect(observationAt(slow, 1100)).toBe('running');
    expect(observationAt(slow, 1500)).toBe('gone');
  });

  it('does not use an absent look as gone when the running look it follows arrived after it was sent', () => {
    const overlapping: Sample[] = [
      { sentMs: 0, atMs: 900, state: 'running' },
      { sentMs: 500, atMs: 600, state: 'absent' },
    ];
    expect(observationAt(overlapping, 700)).toBe('not observable');
  });
});

describe('readTimeout', () => {
  it('is inconclusive when the transaction was never seen running', () => {
    const reading = readTimeout(samples(-500, 16200, () => 'absent'), raisedAt1100, 1000, 15000);
    expect(reading.verdict).toBe('inconclusive');
    expect(reading.seenRunningBeforeTimeout).toBe(false);
  });

  it('is inconclusive when the server list could not be read', () => {
    expect(readTimeout(samples(-500, 16200, () => 'unreadable'), raisedAt1100, 1000, 15000).verdict).toBe('inconclusive');
  });

  it('is inconclusive when the list stops being readable before the end', () => {
    const observed = samples(-500, 16200, (t) => (t < 900 ? 'running' : t < 2000 ? 'absent' : 'unreadable'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000).verdict).toBe('inconclusive');
  });

  it('is inconclusive when the transaction is still open with no query 15 s later', () => {
    const observed = samples(-500, 16200, (t) => (t < 900 ? 'running' : 'idle'));
    expect(readTimeout(observed, returnedAt400, 1000, 15000).verdict).toBe('inconclusive');
  });

  it('reads gone at the next look when no look after the call found it running', () => {
    const observed = samples(-500, 16200, (t) => (t < 1000 ? 'running' : 'absent'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000)).toMatchObject({
      verdict: 'gone-at-next-look',
      atCallEnd: 'gone',
      afterTail: 'gone',
      seenRunningBeforeTimeout: true,
    });
  });

  it('reads gone at the next look when the last look before the call ended still found it running', () => {
    const observed = samples(-500, 16200, (t) => (t < 900 ? 'running' : 'absent'));
    const end: CallEnd = { kind: 'raised', atMs: 950, errorClass: 'Neo4jError', code: 'x' };
    expect(readTimeout(observed, end, 1000, 15000)).toMatchObject({ verdict: 'gone-at-next-look', atCallEnd: 'running', firstGoneMs: 1000, lastRunningMs: 500 });
  });

  it('reads gone later when looks after the call ended still found it running', () => {
    const observed = samples(-500, 16200, (t) => (t < 4000 ? 'running' : 'absent'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000)).toMatchObject({ verdict: 'gone-later', firstGoneMs: 4000 });
  });

  it('is inconclusive when the list could not be read around the end of the call, even if it later shows absence', () => {
    const observed = samples(-500, 16200, (t) => (t < 1000 ? 'running' : t < 14000 ? 'unreadable' : 'absent'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000).verdict).toBe('inconclusive');
  });

  it('does not call it gone at the next look when the looks after the call could not be read', () => {
    const observed = samples(-500, 16200, (t) => (t < 1100 ? 'running' : t < 14000 ? 'unreadable' : 'absent'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000)).toMatchObject({ verdict: 'gone-later', atCallEnd: 'running' });
  });

  it('reads gone later when the first look after the call still found it running', () => {
    const observed = samples(-500, 16200, (t) => (t < 2000 ? 'running' : 'absent'));
    expect(readTimeout(observed, raisedAt1100, 1000, 15000).verdict).toBe('gone-later');
  });

  it('reads still running when it is listed 15 s after the call ended', () => {
    expect(readTimeout(samples(-500, 16200, () => 'running'), raisedAt1100, 1000, 15000).verdict).toBe('still-running');
  });

  it('reads a call that returned like any other end', () => {
    const observed = samples(-500, 16200, (t) => (t < 300 ? 'running' : 'absent'));
    expect(readTimeout(observed, returnedAt400, 1000, 15000).verdict).toBe('gone-at-next-look');
  });

  it('measures a call that never settled from the settle limit', () => {
    const end: CallEnd = { kind: 'unsettled', atMs: 30000 };
    expect(readTimeout(samples(-500, 45200, () => 'running'), end, 1000, 15000)).toMatchObject({ verdict: 'still-running', tailAtMs: 45000 });
  });
});

describe('readClose', () => {
  const timeoutMs = 20000;

  it('is inconclusive when the transaction was not seen running before the close', () => {
    expect(readClose(samples(-500, 45200, () => 'absent'), 2000, timeoutMs, false).verdict).toBe('inconclusive');
  });

  it('is inconclusive when it was only seen running after the close', () => {
    const observed = samples(-500, 45200, (t) => (t > 2000 && t < 20000 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({ verdict: 'inconclusive', seenRunningBeforeClose: false });
  });

  it('is inconclusive when the read had already returned before the close', () => {
    const observed = samples(-500, 45200, (t) => (t < 2300 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, true)).toMatchObject({ verdict: 'inconclusive', callEndedBeforeClose: true });
  });

  it('reads gone within 5 s when it is gone 5 s after the close', () => {
    const observed = samples(-500, 45200, (t) => (t < 2200 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({ verdict: 'gone-within-5s', after5s: 'gone' });
  });

  it('reads gone within 15 s when it is running at 5 s and gone several seconds later', () => {
    const observed = samples(-500, 45200, (t) => (t < 12000 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({ verdict: 'gone-within-15s', after5s: 'running', firstGoneMs: 12000 });
  });

  it('reads gone within 15 s when it disappears before the timeout', () => {
    const observed = samples(-500, 45200, (t) => (t < 16000 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({ verdict: 'gone-within-15s', atTimeout: 'gone' });
  });

  it('reports the state at the timeout and shortly after it separately', () => {
    const observed = samples(-500, 45200, (t) => (t < 21000 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({
      verdict: 'gone-by-timeout-plus-2s',
      atTimeout: 'running',
      atTimeoutPlusGrace: 'gone',
      lastRunningMs: 20500,
      firstGoneMs: 21000,
    });
  });

  it('names the grace checkpoint when it disappears after the deadline', () => {
    const observed = samples(-500, 45200, (t) => (t < 30000 ? 'running' : 'absent'));
    expect(readClose(observed, 2000, timeoutMs, false)).toMatchObject({ verdict: 'running-at-timeout-plus-2s', atTimeout: 'running', atTimeoutPlusGrace: 'running' });
  });

  it('reads running at the grace checkpoint when it is still listed there', () => {
    expect(readClose(samples(-500, 45200, () => 'running'), 2000, timeoutMs, false).verdict).toBe('running-at-timeout-plus-2s');
  });
});
