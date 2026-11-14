/** One text for one value: objects with their keys sorted, so equal values give equal text whatever the order they were built in. */
export function canonicalText(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return (value as readonly unknown[]).map(sorted);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, entry]) => [key, sorted(entry)]));
  return value;
}
