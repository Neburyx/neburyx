/**
 * The keys of the elements selected on the canvas that the turn may use: those that are also keys of the view, each once, in the order of the view's keys. Anything else the client sent (a key of no element in view, a duplicate, a key of
 * another source) is dropped and never an error, as the selection is a hint and not a request.
 */
export function selectedKeysOf(viewElementKeys: readonly string[], selectionKeys: readonly string[] | undefined): readonly string[] {
  if (selectionKeys === undefined || selectionKeys.length === 0) return [];
  const asked = new Set(selectionKeys);
  const seen = new Set<string>();
  return viewElementKeys.filter((key) => {
    if (!asked.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
