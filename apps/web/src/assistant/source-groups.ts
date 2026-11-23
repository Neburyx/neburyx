import type { CitationEntry } from '../summary/summary-model.js';

export type SourceRow =
  | { readonly kind: 'single'; readonly entry: CitationEntry }
  | { readonly kind: 'group'; readonly id: string; readonly text: string; readonly numbers: string; readonly members: readonly CitationEntry[] };

interface Candidate {
  readonly id: string;
  readonly textOf: (count: number) => string;
}

function candidatesOf(entry: CitationEntry): readonly Candidate[] {
  const { shape } = entry;
  if (shape === undefined) return [];
  const { relationshipType: type, from, to } = shape;
  return [
    { id: JSON.stringify([type, from.type, to.key]), textOf: (count) => `${count} ${from.typeName} → ${to.title} · ${type}` },
    { id: JSON.stringify([type, from.key, to.type]), textOf: (count) => `${count} ${from.title} → ${to.typeName} · ${type}` },
  ];
}

/** The numbers of a group as ranges: "3–27" when they run on, "3–5, 9" when another shape sits between. */
export function numberRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((left, right) => left - right);
  const runs: [number, number][] = [];
  for (const number of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] + 1 === number) last[1] = number;
    else runs.push([number, number]);
  }
  return runs.map(([first, end]) => (first === end ? `${first}` : `${first}–${end}`)).join(', ');
}

/**
 * Gathers the relationship rows that share a shape: the same relationship type and entity type at the "from" end and the same element at the "to" end, or the mirror. A row joins the shape that holds the most rows (the first of the two on a tie) and belongs to one group; a group takes the place of its first row.
 */
export function groupSources(entries: readonly CitationEntry[]): readonly SourceRow[] {
  const sizes = new Map<string, number>();
  for (const entry of entries) for (const candidate of candidatesOf(entry)) sizes.set(candidate.id, (sizes.get(candidate.id) ?? 0) + 1);
  const chosen = entries.map((entry) => {
    const best = candidatesOf(entry).reduce<Candidate | undefined>((current, candidate) => {
      const size = sizes.get(candidate.id) ?? 0;
      return size >= 2 && size > (current === undefined ? 1 : (sizes.get(current.id) ?? 0)) ? candidate : current;
    }, undefined);
    return best;
  });
  const members = new Map<string, CitationEntry[]>();
  chosen.forEach((candidate, index) => {
    const entry = entries[index];
    if (candidate === undefined || entry === undefined) return;
    members.set(candidate.id, [...(members.get(candidate.id) ?? []), entry]);
  });
  const placed = new Set<string>();
  return entries.flatMap((entry, index): readonly SourceRow[] => {
    const candidate = chosen[index];
    if (candidate === undefined) return [{ kind: 'single', entry }];
    const group = members.get(candidate.id) ?? [];
    if (group.length < 2) return [{ kind: 'single', entry }];
    if (placed.has(candidate.id)) return [];
    placed.add(candidate.id);
    return [{ kind: 'group', id: candidate.id, text: candidate.textOf(group.length), numbers: numberRanges(group.map((member) => member.number)), members: group }];
  });
}
