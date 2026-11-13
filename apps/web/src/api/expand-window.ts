/** The window of an expansion as the person chose it: a number of days, or all time (no window is sent). */
export type ExpandWindow = { readonly days: number } | 'all';

/** The window of an expansion until a person chooses another: the last 7 days, shown in the controls. */
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_WINDOW: ExpandWindow = { days: DEFAULT_WINDOW_DAYS };

/** The most days a window may name, as the server takes it; "All time" has no limit. */
export const MAX_WINDOW_DAYS = 3650;

export const windowKey = (window: ExpandWindow): string => (window === 'all' ? 'all' : `days:${window.days}`);

/** What the request carries for a window: nothing for all time. */
export const windowRequestOf = (window: ExpandWindow): { readonly window: { readonly days: number } } | Record<string, never> => (window === 'all' ? {} : { window: { days: window.days } });

export type DaysRead = { readonly ok: true; readonly days: number } | { readonly ok: false; readonly reason: string };

/** A number of days typed by a person: a whole number from 1 to 3650. */
export function readDays(text: string): DaysRead {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: `Enter a whole number of days from 1 to ${MAX_WINDOW_DAYS}.` };
  const days = Number(trimmed);
  if (days < 1 || days > MAX_WINDOW_DAYS) return { ok: false, reason: `Enter a whole number of days from 1 to ${MAX_WINDOW_DAYS}.` };
  return { ok: true, days };
}
