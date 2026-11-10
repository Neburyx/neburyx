const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const two = (value: number): string => String(value).padStart(2, '0');

/** `hh:mm` of an ISO-8601 time in UTC; the caller adds the word UTC. */
export function utcTime(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** `30 Oct 2026 09:42` of an ISO-8601 time in UTC; the caller adds the word UTC. */
export function utcDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()} ${utcTime(iso)}`;
}
