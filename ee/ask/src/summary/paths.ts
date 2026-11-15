import { ASK_SUMMARY_MAX_CITATIONS, ASK_SUMMARY_MAX_SENTENCES, pathSentenceStart, type GraphEdge, type PathsOk } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { edgeItem, nodeItem, nodeMap } from './shared.js';
import { nodeTitle, refId } from './title.js';

/** The most path sentences: one sentence is the heading of twelve. */
const MAX_PATH_SENTENCES = 11;
/** A title in a sentence is cut here, so that a path of long titles can still fit the sentence limit. */
const TITLE_LENGTH = 40;

type Step = PathsOk['paths'][number]['steps'][number];

const sameEnds = (edge: GraphEdge, step: Step): boolean =>
  edge.type === step.relationshipType &&
  ((refId(edge.from) === refId(step.from) && refId(edge.to) === refId(step.to)) || (refId(edge.from) === refId(step.to) && refId(edge.to) === refId(step.from)));

/** The relationship a step walked: the ones of its type between its two ends, and when several join the same pair, the one that carries the step's own evidence references. */
function edgeOfStep(edges: readonly GraphEdge[], step: Step): GraphEdge | undefined {
  const candidates = edges.filter((edge) => sameEnds(edge, step));
  return candidates.find((edge) => edge.evidenceRefs.length === step.evidenceRefs.length && edge.evidenceRefs.every((reference, index) => reference === step.evidenceRefs[index])) ?? candidates[0];
}

const short = (title: string): string => ([...title].length > TITLE_LENGTH ? `${[...title].slice(0, TITLE_LENGTH).join('')}…` : title);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The entities and relationships a path answer lists, which a citation may name. */
export function pathsListed(result: PathsOk): ListedElements {
  const nodes = nodeMap(result.nodes);
  return listOf([...result.nodes.map(nodeItem), ...result.edges.map((edge) => edgeItem(edge, nodes))]);
}

/**
 * A heading with the number of paths and what is known of their completeness, citing the two ends, and for each path (at most eleven) a short sentence that carries the citations of its entities and relationships: the
 * answer card shows the heading as the answer and each path's markers on its own card. A path that does not fit the limits of a summary is left out and counted by the builder's own line of left-out statements; the paths
 * beyond the eleventh are counted in the omissions line here; every path stays in the result.
 */
export function summarizePaths(result: PathsOk): ReturnType<SummaryBuilder['finish']> {
  const first = result.paths[0];
  const last = first?.steps[first.steps.length - 1];
  const start = first?.steps[0];
  if (first === undefined || start === undefined || last === undefined) return undefined;
  const nodes = nodeMap(result.nodes);
  const titleOf = (ref: Step['from']): string => {
    const listed = nodes.get(refId(ref));
    return short(listed === undefined ? ref.stableId : nodeTitle(listed));
  };
  const builder = new SummaryBuilder(pathsListed(result));
  const between = `between ${titleOf(start.from)} and ${titleOf(last.to)}`;
  const count = result.paths.length;
  const heading = result.partial
    ? `Found ${result.retained ?? count} of ${result.requested ?? count} requested paths ${between} before the search timed out; not exhaustive.`
    : `Found ${plural(count, 'shortest path', 'shortest paths')} of ${plural(first.hops, 'hop', 'hops')} ${between}.${result.capReached ? ` The limit of ${plural(count, 'path', 'paths')} was reached; more paths of this length exist.` : ''}`;
  builder.add(heading, [start.from, last.to]);
  const cited = new Set([refId(start.from), refId(last.to)]);
  let sentences = 1;
  let described = 0;
  for (const [index, path] of result.paths.slice(0, MAX_PATH_SENTENCES).entries()) {
    const ends = path.steps.flatMap((step) => [step.from, step.to]);
    const refs = [...ends, ...path.steps.flatMap((step) => {
      const edge = edgeOfStep(result.edges, step);
      return edge === undefined ? [] : [edge.ref];
    })];
    const fresh = new Set(refs.map(refId).filter((id) => !cited.has(id)));
    // a path the limits of a summary would refuse is not offered to the builder, so that it is counted once, by the line below
    if (sentences >= ASK_SUMMARY_MAX_SENTENCES || cited.size + fresh.size > ASK_SUMMARY_MAX_CITATIONS) continue;
    builder.add(`${pathSentenceStart(index + 1)} ${plural(path.hops, 'hop', 'hops')}.`, refs);
    for (const id of fresh) cited.add(id);
    sentences += 1;
    described += 1;
  }
  const without = count - described;
  return builder.finish(without === 0 ? undefined : `${plural(without, 'path has', 'paths have')} no source numbers; ${without === 1 ? 'it is' : 'they are'} in the result.`);
}
