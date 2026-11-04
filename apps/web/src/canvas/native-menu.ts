/** Stops the browser's own context menu from opening on `element`; returns the function that lets it open again. */
export function suppressNativeMenu(element: HTMLElement): () => void {
  const prevent = (event: Event): void => event.preventDefault();
  element.addEventListener('contextmenu', prevent);
  return () => element.removeEventListener('contextmenu', prevent);
}
