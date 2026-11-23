import type { CitationEntry } from "../summary/summary-model.js";
import { MARKER_RUN_MIN } from "./copy.js";

export type MarkerGroup =
  | { readonly kind: "single"; readonly entry: CitationEntry }
  | { readonly kind: "run"; readonly first: CitationEntry; readonly last: CitationEntry };

/** The markers of one sentence in citation order: when `foldRuns` is set (a Sources list is there for a range to open), a run of MARKER_RUN_MIN or more consecutive numbers is one range, any other number stands alone. */
export function markerGroups(entries: readonly CitationEntry[], foldRuns: boolean): readonly MarkerGroup[] {
  if (!foldRuns) return entries.map((entry) => ({ kind: "single", entry }));
  const groups: MarkerGroup[] = [];
  let run: CitationEntry[] = [];
  const flush = (): void => {
    const first = run[0];
    const last = run.at(-1);
    if (first !== undefined && last !== undefined && run.length >= MARKER_RUN_MIN) groups.push({ kind: "run", first, last });
    else for (const entry of run) groups.push({ kind: "single", entry });
    run = [];
  };
  for (const entry of entries) {
    const previous = run.at(-1);
    if (previous !== undefined && entry.number !== previous.number + 1) flush();
    run.push(entry);
  }
  flush();
  return groups;
}
