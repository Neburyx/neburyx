import { useEffect, useState } from 'react';

export interface ElementSize {
  readonly width: number | undefined;
  readonly height: number | undefined;
}

const UNMEASURED: ElementSize = { width: undefined, height: undefined };

const known = (value: number): number | undefined => (value > 0 ? value : undefined);

/** The element's size as it changes; unmeasured until it was, and where the browser cannot observe sizes. */
export function useElementSize(element: Element | null): ElementSize {
  const [size, setSize] = useState<ElementSize>(UNMEASURED);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (width: number, height: number): void => setSize((held) => (held.width === known(width) && held.height === known(height) ? held : { width: known(width), height: known(height) }));
    const rect = element.getBoundingClientRect();
    measure(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
