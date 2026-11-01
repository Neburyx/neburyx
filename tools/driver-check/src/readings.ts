export type SampleState = 'running' | 'idle' | 'absent' | 'ending' | 'unreadable';

/**
 * One look at the server's transaction list, in milliseconds since the query started (negative before it).
 * The state held at some instant between `sentMs` and `atMs`, when the answer arrived.
 */
export interface Sample {
  readonly sentMs: number;
  readonly atMs: number;
  readonly state: SampleState;
  readonly detail?: string;
}

export type Observation = 'running' | 'idle' | 'gone' | 'not observable';

export type CallEnd =
  | { readonly kind: 'raised'; readonly atMs: number; readonly errorClass: string; readonly code: string }
  | { readonly kind: 'returned'; readonly atMs: number; readonly rows: number }
  | { readonly kind: 'unsettled'; readonly atMs: number };

export type CloseEnd =
  | { readonly kind: 'returned'; readonly calledAtMs: number; readonly atMs: number }
  | { readonly kind: 'raised'; readonly calledAtMs: number; readonly atMs: number; readonly errorClass: string; readonly code: string }
  | { readonly kind: 'unsettled'; readonly calledAtMs: number };

/** A look sent longer ago than this at the moment asked about no longer says anything about it. */
export const STALE_MS = 1000;
/** The server enforces a timeout some time after it is reached, and sampling adds up to one interval. */
export const TIMEOUT_GRACE_MS = 2000;

export function seenRunning(samples: readonly Sample[], byMs: number): boolean {
  return samples.some((s) => s.state === 'running' && s.atMs <= byMs);
}

export function observationAt(samples: readonly Sample[], atMs: number): Observation {
  let last: Sample | undefined;
  for (const s of samples) if (s.atMs <= atMs && (!last || s.atMs >= last.atMs)) last = s;
  if (!last || atMs - last.sentMs > STALE_MS) return 'not observable';
  if (last.state === 'running') return 'running';
  if (last.state === 'idle') return 'idle';
  if (last.state === 'absent' && seenRunning(samples, last.sentMs)) return 'gone';
  return 'not observable';
}

export interface Transition {
  readonly lastRunningMs?: number;
  readonly firstGoneMs?: number;
}

/** When the last look that found the query running was answered, and the first later look that found the transaction gone. */
export function transitionOf(samples: readonly Sample[]): Transition {
  const running = samples.filter((s) => s.state === 'running').map((s) => s.atMs);
  if (running.length === 0) return {};
  const lastRunningMs = Math.max(...running);
  const gone = samples.filter((s) => s.state === 'absent' && s.sentMs >= lastRunningMs).map((s) => s.atMs);
  return gone.length > 0 ? { lastRunningMs, firstGoneMs: Math.min(...gone) } : { lastRunningMs };
}

/**
 * `gone-at-next-look`: the first look sent after the call ended found the transaction gone.
 * `gone-later`: a later look did; the looks between found it running or could not read the list.
 */
export type TimeoutVerdict = 'gone-at-next-look' | 'gone-later' | 'still-running' | 'inconclusive';

export interface TimeoutReading extends Transition {
  readonly verdict: TimeoutVerdict;
  readonly seenRunningBeforeTimeout: boolean;
  readonly atCallEnd: Observation;
  readonly afterTail: Observation;
  readonly tailAtMs: number;
}

export function readTimeout(
  samples: readonly Sample[],
  end: CallEnd,
  timeoutMs: number,
  tailMs: number,
): TimeoutReading {
  const tailAtMs = end.atMs + tailMs;
  const seen = seenRunning(samples, timeoutMs);
  const atCallEnd = observationAt(samples, end.atMs);
  const afterTail = observationAt(samples, tailAtMs);
  let verdict: TimeoutVerdict = 'inconclusive';
  if (seen && atCallEnd !== 'not observable') {
    if (afterTail === 'running') verdict = 'still-running';
    else if (afterTail === 'gone') {
      const nextLook = samples.filter((s) => s.sentMs > end.atMs).sort((a, b) => a.sentMs - b.sentMs)[0];
      verdict = nextLook?.state === 'absent' ? 'gone-at-next-look' : 'gone-later';
    }
  }
  return { verdict, seenRunningBeforeTimeout: seen, atCallEnd, afterTail, tailAtMs, ...transitionOf(samples) };
}

/** `TIMEOUT_GRACE_MS` is 2,000 ms: the last two verdicts are about the state 2 s after the transaction's timeout. */
export type CloseVerdict =
  | 'gone-within-5s'
  | 'gone-within-15s'
  | 'gone-by-timeout-plus-2s'
  | 'running-at-timeout-plus-2s'
  | 'inconclusive';

export interface CloseReading extends Transition {
  readonly verdict: CloseVerdict;
  readonly seenRunningBeforeClose: boolean;
  readonly callEndedBeforeClose: boolean;
  readonly after5s: Observation;
  readonly after15s: Observation;
  readonly atTimeout: Observation;
  readonly atTimeoutPlusGrace: Observation;
}

export function readClose(
  samples: readonly Sample[],
  closeCalledAtMs: number,
  timeoutMs: number,
  callEndedBeforeClose: boolean,
): CloseReading {
  const seen = seenRunning(samples, closeCalledAtMs);
  const after5s = observationAt(samples, closeCalledAtMs + 5000);
  const after15s = observationAt(samples, closeCalledAtMs + 15000);
  const atTimeout = observationAt(samples, timeoutMs);
  const atTimeoutPlusGrace = observationAt(samples, timeoutMs + TIMEOUT_GRACE_MS);
  let verdict: CloseVerdict = 'inconclusive';
  if (seen && !callEndedBeforeClose) {
    if (after5s === 'gone') verdict = 'gone-within-5s';
    else if (after15s === 'gone') verdict = 'gone-within-15s';
    else if (after15s === 'running' && atTimeoutPlusGrace === 'gone') verdict = 'gone-by-timeout-plus-2s';
    else if (after15s === 'running' && atTimeoutPlusGrace === 'running') verdict = 'running-at-timeout-plus-2s';
  }
  return { verdict, seenRunningBeforeClose: seen, callEndedBeforeClose, after5s, after15s, atTimeout, atTimeoutPlusGrace, ...transitionOf(samples) };
}
