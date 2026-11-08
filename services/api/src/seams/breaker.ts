import { realTimer, type SetTimer, type Timer } from './read-slots.js';
import type { BreakerLimits, Coordinator, ReadAccessRequest, ReadAdmission, ReadLease, ReadOutcome } from './seams.js';

export interface BreakerOptions {
  readonly clock?: () => number;
  /** Schedules the end of a trial read that was never released. */
  readonly setTimer?: SetTimer;
}

interface Trial {
  readonly startedAt: number;
  readonly ttlMs: number;
  expiry: Timer | undefined;
}

interface SourceState {
  phase: 'closed' | 'open' | 'half-open';
  /** Changes with every move between phases; an outcome from an earlier one changes nothing. */
  generation: number;
  /** The times of the timeouts that count, at most `failures` of them. */
  timeouts: number[];
  openUntil: number;
  trial: Trial | undefined;
}

const refused = (retryAfterMs: number): ReadAdmission => ({ status: 'unavailable', reason: 'repeated-timeouts', retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) });

/**
 * A circuit breaker per source in front of the read slots. `failures` timeouts within `windowMs` open it; while open every read is refused, before the slots are asked, until `cooldownMs` has passed.
 * Then one trial read (the data read of a person's request) is admitted: if it answers the breaker closes, if it times out the breaker opens again, and any other end decides nothing. Answers
 * in between do not reset the count. A request without the source's rule goes straight to the slots.
 */
export function withBreaker<T extends Coordinator>(inner: T, options: BreakerOptions = {}): T {
  const clock = options.clock ?? Date.now;
  const setTimer = options.setTimer ?? realTimer;
  const states = new Map<string, SourceState>();

  const stateOf = (sourceId: string): SourceState => {
    const found = states.get(sourceId);
    if (found !== undefined) return found;
    const created: SourceState = { phase: 'closed', generation: 0, timeouts: [], openUntil: 0, trial: undefined };
    states.set(sourceId, created);
    return created;
  };

  const move = (state: SourceState, phase: SourceState['phase']): void => {
    state.phase = phase;
    state.generation += 1;
    state.timeouts = [];
    state.trial = undefined;
  };

  const open = (state: SourceState, limits: BreakerLimits): void => {
    move(state, 'open');
    state.openUntil = clock() + limits.cooldownMs;
  };

  const countTimeout = (state: SourceState, limits: BreakerLimits): void => {
    const now = clock();
    state.timeouts = [...state.timeouts, now].filter((at) => now - at <= limits.windowMs).slice(-limits.failures);
    if (state.timeouts.length >= limits.failures) open(state, limits);
  };

  const endTrial = (state: SourceState, trial: Trial): void => {
    trial.expiry?.cancel();
    if (state.trial === trial) state.trial = undefined;
  };

  /** A lease whose release tells the breaker how the read ended; only the first release does. */
  const watched = (lease: ReadLease, state: SourceState, limits: BreakerLimits, decides: boolean, trial: Trial | undefined): ReadLease => {
    const generation = state.generation;
    let released = false;
    return {
      release: (outcome) => {
        if (!released) {
          released = true;
          if (trial !== undefined) {
            if (state.trial === trial && state.generation === generation) {
              endTrial(state, trial);
              if (outcome === 'answered') move(state, 'closed');
              else if (outcome === 'timeout') open(state, limits);
            }
          } else if (decides && state.generation === generation && state.phase === 'closed' && outcome === 'timeout') {
            countTimeout(state, limits);
          }
        }
        return lease.release(outcome);
      },
    };
  };

  return {
    ...inner,
    async acquireRead(request: ReadAccessRequest): Promise<ReadAdmission> {
      const limits = request.breaker;
      if (limits === undefined) return inner.acquireRead(request);
      const state = stateOf(request.sourceId);
      const now = clock();
      if (state.phase === 'open' && now >= state.openUntil) move(state, 'half-open');
      if (state.phase === 'open') return refused(state.openUntil - now);
      if (state.phase === 'closed') {
        const admission = await inner.acquireRead(request);
        return admission.status === 'granted' ? { status: 'granted', lease: watched(admission.lease, state, limits, true, undefined) } : admission;
      }
      if (state.trial !== undefined) return refused(state.trial.startedAt + state.trial.ttlMs - now);
      // nobody reads this wait: a refused background read is skipped
      if (request.role === 'background') return refused(1);
      if (request.role === 'index') {
        // admitted so that the request can reach its data read; its end decides nothing while the source is recovering
        const admission = await inner.acquireRead(request);
        return admission.status === 'granted' ? { status: 'granted', lease: watched(admission.lease, state, limits, false, undefined) } : admission;
      }
      // marked before the first await, so that two reads arriving together cannot both be the trial
      const trial: Trial = { startedAt: now, ttlMs: request.leaseTtlMs, expiry: undefined, };
      state.trial = trial;
      const generation = state.generation;
      const admission = await inner.acquireRead(request);
      if (admission.status !== 'granted') {
        if (state.trial === trial) state.trial = undefined;
        return admission;
      }
      if (state.trial !== trial || state.generation !== generation) return { status: 'granted', lease: admission.lease };
      trial.expiry = setTimer(() => endTrial(state, trial), request.leaseTtlMs);
      return { status: 'granted', lease: watched(admission.lease, state, limits, true, trial) };
    },
  };
}
