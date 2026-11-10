/**
 * What no response of the API may hold: the element ID of the source's database. It can name another element once the one it named is deleted, so it is never a field, never part of a text, and never
 * a reference. The sweep looks for it two ways: by name (a field called `elementId`, `startElementId`, `element_id` ...) and by value (any element ID the source answered with, anywhere in the body or in a
 * header). A page cursor is sealed (an encoded, signed token), so the position it holds is not found by the scan: that is by design, and the negative tests below show a plain position is.
 */
const ELEMENT_ID_KEY = /element[-_ ]?id/i;

/** Every key of a JSON value, with the path to it. */
function keysOf(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keysOf(entry, `${path}[${index}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [`${path}.${key}`, ...keysOf(entry, `${path}.${key}`)]);
}

/** The element IDs a source answer holds: the value of every `elementId`, `startElementId` and `endElementId`, anywhere in the rows. */
export function elementIdsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) elementIdsIn(entry, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (ELEMENT_ID_KEY.test(key) && typeof entry === 'string' && entry !== '') into.add(entry);
      else elementIdsIn(entry, into);
    }
  }
  return into;
}

export interface SweptResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, unknown>>;
}

/** What is wrong with one response: a field named for an element ID, or an element ID the source answered with. Empty when the response is clean. */
export function sweepFindings(label: string, response: SweptResponse, issued: ReadonlySet<string>): string[] {
  const findings: string[] = [];
  let parsed: unknown;
  try {
    parsed = response.body === '' ? undefined : (JSON.parse(response.body) as unknown);
  } catch {
    parsed = undefined;
  }
  for (const path of keysOf(parsed, '$')) if (ELEMENT_ID_KEY.test(path.split('.').at(-1) ?? '')) findings.push(`${label}: a field named for an element ID at ${path}`);
  const text = `${response.body}\n${JSON.stringify(response.headers)}`;
  for (const id of issued) if (text.includes(id)) findings.push(`${label}: the element ID ${JSON.stringify(id)} the source answered with`);
  return findings;
}
