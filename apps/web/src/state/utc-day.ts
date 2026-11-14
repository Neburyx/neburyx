import { useEffect, useState } from 'react';

const DAY_MS = 86_400_000;
const startOfUtcDay = (instant: number): number => Math.floor(instant / DAY_MS) * DAY_MS;

/** The start of the current UTC day, which changes at 00:00 UTC; a part of the page that reads a `{days}` time window takes it as a dependency so it is judged again for the new day. */
export function useUtcDay(): number {
  const [day, setDay] = useState(() => startOfUtcDay(Date.now()));
  const [early, setEarly] = useState(0);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        const now = startOfUtcDay(Date.now());
        // a timer that fires before midnight by the clock (it was set back) waits again instead of leaving the old day for good
        if (now === day) setEarly((count) => count + 1);
        else setDay(now);
      },
      Math.max(1, day + DAY_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [day, early]);
  return day;
}
