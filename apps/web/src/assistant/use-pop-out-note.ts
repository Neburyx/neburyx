import { useCallback, useEffect, useRef, useState } from 'react';

export type PopOutNote = 'refused' | 'unreachable' | undefined;

/** The empty window that the lookup of a name opens takes the focus and gives it back when it is closed: a focus within this time of the note is that, not the person's return. */
const RETURN_GRACE_MS = 1500;

/** The line the panel shows beside its header after a press of Pop out that opened or switched to nothing. The line about a window that cannot be reached goes when the other window closes, when the person comes back to this window, and when the chat is shown here. */
export function usePopOutNote(pageElsewhere: boolean): { readonly note: PopOutNote; readonly show: (next: PopOutNote) => void; readonly clear: () => void } {
  const [note, setNote] = useState<PopOutNote>(undefined);
  const shownAt = useRef(0);
  const show = useCallback((next: PopOutNote) => {
    shownAt.current = Date.now();
    setNote(next);
  }, []);
  const clear = useCallback(() => setNote(undefined), []);
  useEffect(() => {
    if (!pageElsewhere) setNote((current) => (current === 'unreachable' ? undefined : current));
  }, [pageElsewhere]);
  useEffect(() => {
    if (note !== 'unreachable') return undefined;
    const back = (): void => {
      if (Date.now() - shownAt.current > RETURN_GRACE_MS) setNote(undefined);
    };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [note]);
  return { note, show, clear };
}
