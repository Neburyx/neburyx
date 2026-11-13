/** One relationship of an export: the stable ID of its start and of its end. */
export interface Edge {
  readonly f: string;
  readonly t: string;
}

/** One step of a pattern, over the relationships of the export of the types it lists: the direction it crosses them and the entity type it arrives at. */
export interface ExpectedStep {
  readonly edges: readonly Edge[];
  readonly direction: 'out' | 'in';
  readonly arrivesAt: string;
}

/**
 * The stable IDs of the entities a pattern reaches from an anchor, computed from the export alone: every path that follows the steps in order, in which no entity appears twice, ends at an entity of the last step. This is the set
 * the compiled statement must return on a graph in which no step is cut by the count cap.
 */
export function expectedReach(anchorType: string, anchor: string, steps: readonly ExpectedStep[]): Set<string> {
  let paths: { readonly last: string; readonly seen: ReadonlySet<string> }[] = [{ last: anchor, seen: new Set([`${anchorType}:${anchor}`]) }];
  for (const step of steps) {
    const next: { last: string; seen: ReadonlySet<string> }[] = [];
    for (const path of paths) {
      for (const edge of step.edges) {
        const [from, to] = step.direction === 'out' ? [edge.f, edge.t] : [edge.t, edge.f];
        if (from !== path.last || path.seen.has(`${step.arrivesAt}:${to}`)) continue;
        next.push({ last: to, seen: new Set([...path.seen, `${step.arrivesAt}:${to}`]) });
      }
    }
    paths = next;
  }
  return new Set(paths.map((path) => path.last));
}
