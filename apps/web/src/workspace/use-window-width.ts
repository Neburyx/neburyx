import { useEffect, useState } from 'react';

/** The window's inner width as it changes; the canvas is narrower than the window by the navigation rail. */
export function useWindowWidth(): number | undefined {
  const [width, setWidth] = useState<number | undefined>(() => (typeof window === 'undefined' || window.innerWidth <= 0 ? undefined : window.innerWidth));
  useEffect(() => {
    const measure = (): void => setWidth(window.innerWidth > 0 ? window.innerWidth : undefined);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return width;
}
