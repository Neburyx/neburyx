/** Calls `onChange` when the element's size changes, and returns the function that stops it; where the browser cannot observe sizes it does nothing, and the library's own window listener is all that is left. */
export function followSize(element: Element, onChange: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(onChange);
  observer.observe(element);
  return () => observer.disconnect();
}
