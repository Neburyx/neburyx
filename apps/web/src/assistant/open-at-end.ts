import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How near the end of the thread, in pixels, counts as being at the end. */
const NEAR_END = 24;

/**
 * Opens a stored chat at its latest turn and keeps it there while what is above it settles (the values of the earlier answers are read after it is drawn), until the person scrolls up or a turn of this window is sent: that turn is
 * read from its top. `key` names what was opened (the investigation and its first stored turn), none while nothing is ready; a new key starts again. The scroll is a plain jump, never an animation.
 */
export function useOpenAtEnd(body: RefObject<HTMLElement | null>, key: string | undefined, liveTurns: number): void {
  const following = useRef(false);
  const live = useRef(false);
  const followed = useRef<string | undefined>(undefined);
  /** The position the last jump to the end set: a scroll that lands anywhere else, far from the end, is the person's. */
  const jumped = useRef<number | undefined>(undefined);
  const toEnd = (): void => {
    const element = body.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight - element.clientHeight;
    jumped.current = element.scrollTop;
  };

  // before anything is observed in the same commit: a turn sent here is read from its top, so the jump to the end must not follow it
  useLayoutEffect(() => {
    live.current = liveTurns > 0;
    if (liveTurns > 0) following.current = false;
  }, [liveTurns]);

  useLayoutEffect(() => {
    if (key === undefined || followed.current === key) return;
    followed.current = key;
    following.current = true;
    toEnd();
  });

  useEffect(() => {
    const element = body.current;
    if (element === null) return undefined;
    const keep = (): void => {
      if (following.current) toEnd();
    };
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(keep);
    const watch = (): void => {
      sizes?.disconnect();
      for (const child of element.children) sizes?.observe(child);
      keep();
    };
    const changes = new MutationObserver(watch);
    changes.observe(element, { childList: true });
    watch();
    // by whatever means the person scrolls (wheel, scrollbar, keys, find in page), a position far from the end that the jump did not set ends the following; coming back to the end resumes it
    const onScroll = (): void => {
      const room = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (room <= NEAR_END) {
        if (!live.current && followed.current !== undefined) following.current = true;
      } else if (jumped.current === undefined || Math.abs(element.scrollTop - jumped.current) > 1) {
        following.current = false;
      }
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sizes?.disconnect();
      changes.disconnect();
      element.removeEventListener('scroll', onScroll);
    };
  }, [body]);
}
