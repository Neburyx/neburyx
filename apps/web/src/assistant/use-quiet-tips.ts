import { useEffect, useRef, useState } from 'react';

/** True from a change of the panel's header (it collapses or comes back, and Clear chat goes or returns) until the pointer moves: the buttons move under a pointer that has not, and the tip of the one that is now under it would show without the person pointing at it. */
export function useQuietTipsAfterLayoutChange(collapsed: boolean): boolean {
  const [quiet, setQuiet] = useState(false);
  const before = useRef(collapsed);
  useEffect(() => {
    if (before.current === collapsed) return undefined;
    before.current = collapsed;
    setQuiet(true);
    const moved = (): void => setQuiet(false);
    window.addEventListener('pointermove', moved, { once: true });
    return () => window.removeEventListener('pointermove', moved);
  }, [collapsed]);
  return quiet;
}
