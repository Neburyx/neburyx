/** One relationship of an export: the stable ID of its start and of its end. */
interface Edge {
  readonly f: string;
  readonly t: string;
  /** The observed time of the relationship, in milliseconds, when the export has one and a step reads it. */
  readonly at?: number;
}

/** One step of a pattern, over the relationships of the export of the types it lists: the direction it crosses them and the entity type it arrives at. */
export interface ExpectedStep {
  readonly edges: readonly Edge[];
  readonly direction: 'out' | 'in';
  readonly arrivesAt: string;
  /** The step is ordered after the previous one: its relationship has a time at or after the previous relationship's (a relationship with no time is never on such a path). */
  readonly ordered?: boolean;
  /** With `ordered`: the relationship's time is no later than the previous one's plus this many minutes. */
  readonly withinMinutes?: number;
  /** The node the step starts from has at least this many distinct neighbours over the step's edges in its direction (a node on the path counts; the time order is not applied to the count). */
  readonly fan?: number;
}

/**
 * The stable IDs of the entities a pattern reaches from an anchor, computed from the export alone: every path that follows the steps in order, in which no entity appears twice, ends at an entity of the last step. This is the set
 * the compiled statement must return on a graph in which no step is cut by the count cap.
 */
export function expectedReach(anchorType: string, anchor: string, steps: readonly ExpectedStep[]): Set<string> {
  let paths: { readonly last: string; readonly seen: ReadonlySet<string>; readonly at: number | undefined }[] = [{ last: anchor, seen: new Set([`${anchorType}:${anchor}`]), at: undefined }];
  for (const step of steps) {
    const next: { last: string; seen: ReadonlySet<string>; at: number | undefined }[] = [];
    for (const path of paths) {
      if (step.fan !== undefined) {
        const neighbours = new Set(step.edges.filter((edge) => (step.direction === 'out' ? edge.f : edge.t) === path.last).map((edge) => (step.direction === 'out' ? edge.t : edge.f)));
        if (neighbours.size < step.fan) continue;
      }
      for (const edge of step.edges) {
        const [from, to] = step.direction === 'out' ? [edge.f, edge.t] : [edge.t, edge.f];
        if (from !== path.last || path.seen.has(`${step.arrivesAt}:${to}`)) continue;
        if (step.ordered === true && (edge.at === undefined || path.at === undefined || Number.isNaN(edge.at) || Number.isNaN(path.at) || edge.at < path.at)) continue;
        if (step.ordered === true && step.withinMinutes !== undefined && (edge.at ?? 0) - (path.at ?? 0) > step.withinMinutes * 60_000) continue;
        next.push({ last: to, seen: new Set([...path.seen, `${step.arrivesAt}:${to}`]), at: edge.at });
      }
    }
    paths = next;
  }
  return new Set(paths.map((path) => path.last));
}
