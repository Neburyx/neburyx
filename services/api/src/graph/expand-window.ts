import type { Window } from '@neburyx/contracts';
import { windowInstantsOf, type WindowInstants } from './template-window.js';

const DAY_MS = 86_400_000;

/**
 * The two instants of the window of an expansion at a time. A number of days is read as whole UTC days, so that the window, which the cursor of every page binds, is the same for every request of one UTC day:
 * from 00:00 UTC of the day `days` days before today up to but not including 00:00 UTC of tomorrow, which holds at least `days` x 24 hours. A range of dates is read as for a template run.
 */
export function expandWindowInstantsOf(window: Window, now: Date): WindowInstants {
  if (!('days' in window)) return windowInstantsOf(window, now);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { windowFrom: new Date(today - window.days * DAY_MS).toISOString(), windowTo: new Date(today + DAY_MS).toISOString() };
}
