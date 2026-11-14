import type { ExpandResponse, GraphNode } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import type { Count } from '@neburyx/contracts';
import { countWords, remainderSentence } from './counts.js';
import { SHOWN_NAMES, anchorItem, edgeItem, nameList, nodeItem, nodeMap } from './shared.js';
import { nodeTitle, refId } from './title.js';

export function expandListed(result: ExpandResponse): ListedElements {
  const nodes = nodeMap(result.nodes);
  return listOf([anchorItem(result.ref, nodes), ...result.nodes.map(nodeItem), ...result.edges.map((edge) => edgeItem(edge, nodes))]);
}

export function summarizeExpand(result: ExpandResponse): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(expandListed(result));
  const nodes = nodeMap(result.nodes);
  const anchor = anchorItem(result.ref, nodes);
  const anchorId = refId(result.ref);
  for (const page of result.pages) {
    const neighbors = result.nodes.filter((node) => node.display.type === page.neighborType && refId(node.ref) !== anchorId);
    const named: GraphNode[] = neighbors.slice(0, SHOWN_NAMES);
    const more = page.hasMore ? ' More pages exist.' : '';
    const including = named.length === 0 ? '' : `, including ${nameList(named.map(nodeTitle))}`;
    builder.add(`${page.neighborType} of ${anchor.title}: ${page.returned} returned (total: ${countWords(page.matchingTotal)})${including}.${more}`, [result.ref, ...named.map((node) => node.ref)]);
  }
  if (result.pages.length === 0) builder.add(`No neighbors of ${anchor.title} were returned.`, [result.ref]);
  return builder.finish(result.pages.length === 0 ? undefined : remainderSentence(combinedTotal(result.pages.map((page) => page.matchingTotal)), result.pages.reduce((sum, page) => sum + page.returned, 0)));
}

/** The total of several pages: exact when every page's is, estimated as soon as one is an estimate (it can be too high, so the sum is no bound), a lower bound only when every other one is, and unknown as soon as one has no value. */
function combinedTotal(counts: readonly Count[]): Count {
  if (counts.some((count) => count.value === undefined)) return { quality: 'unknown', scope: 'expansion' };
  const value = counts.reduce((sum, count) => sum + (count.value ?? 0), 0);
  const quality = counts.some((count) => count.quality === 'estimated') ? 'estimated' : counts.some((count) => count.quality === 'lowerBound') ? 'lowerBound' : 'exact';
  return { quality, value, scope: 'expansion' };
}
