import type { Window } from '@neburyx/contracts';

const DAY_MS = 86_400_000;

export interface WindowInstants {
  readonly windowFrom: string;
  readonly windowTo: string;
}

/** The two instants of a window at a time: the last `days` x 24 hours up to now, or 00:00 UTC on `from` up to but not including 00:00 UTC on the day after `to`. */
export function windowInstantsOf(window: Window, now: Date): WindowInstants {
  if ('days' in window) return { windowFrom: new Date(now.getTime() - window.days * DAY_MS).toISOString(), windowTo: now.toISOString() };
  return { windowFrom: `${window.from}T00:00:00.000Z`, windowTo: new Date(Date.parse(`${window.to}T00:00:00Z`) + DAY_MS).toISOString() };
}
