import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { NEAR_END } from './open-at-end.js';

/**
 * Gives the thread its place back when the panel returns from being collapsed: the thread is hidden while collapsed and a hidden element loses its scroll position. The place the person had is kept; at the end of the thread, or when a turn came while the panel was collapsed (`count` rose), it comes back at the latest turn.
 */
export function useKeepPlaceWhileCollapsed(body: RefObject<HTMLElement | null>, collapsed: boolean, count: number): void {
  const place = useRef({ top: 0, atEnd: true, count });
  const was = useRef(collapsed);
  useEffect(() => {
    const element = body.current;
    if (element === null) return undefined;
    const onScroll = (): void => {
      if (!was.current) place.current = { ...place.current, top: element.scrollTop, atEnd: element.scrollHeight - element.clientHeight - element.scrollTop <= NEAR_END };
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [body]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!collapsed) {
      if (was.current && element !== null) {
        element.scrollTop = place.current.atEnd || count > place.current.count ? element.scrollHeight - element.clientHeight : place.current.top;
      }
      place.current = { ...place.current, count };
    }
    was.current = collapsed;
  }, [body, collapsed, count]);
}
