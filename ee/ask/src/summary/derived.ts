import type { DerivedEdgeDetail, DerivedNeighborsResponse, GraphNode } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type Listed, type ListedElements } from './core.js';
import { countWords } from './counts.js';
import { SHOWN_NAMES, anchorItem, edgeItem, nameList, nodeItem, nodeMap } from './shared.js';
import { nodeTitle, refId } from './title.js';

export function derivedRuleListed(result: DerivedNeighborsResponse): ListedElements {
  const nodes = nodeMap(result.results.flatMap((entry) => entry.nodes));
  return listOf([anchorItem(result.ref, nodes), ...result.results.flatMap((entry) => [...entry.nodes.map(nodeItem), ...entry.edges.map((edge) => edgeItem(edge, nodes))])]);
}

export function summarizeDerivedRule(result: DerivedNeighborsResponse): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(derivedRuleListed(result));
  const allNodes = nodeMap(result.results.flatMap((entry) => entry.nodes));
  const anchor = anchorItem(result.ref, allNodes);
  const anchorId = refId(result.ref);
  for (const entry of result.results) {
    const nodes = nodeMap(entry.nodes);
    const label = `Rule ${entry.ruleId} (version ${entry.ruleVersion})`;
    if (entry.count.quality === 'exact' && entry.count.value === 0) {
      builder.add(`${label} found nothing linked to ${anchor.title}.`, [result.ref]);
      continue;
    }
    const ends: GraphNode[] = [];
    for (const edge of entry.edges) {
      if (edge.semantics !== 'derived') continue;
      const other = refId(edge.from) === anchorId ? edge.to : edge.from;
      const node = nodes.get(refId(other));
      if (node !== undefined && !ends.includes(node)) ends.push(node);
    }
    const named = ends.slice(0, SHOWN_NAMES);
    const including = named.length === 0 ? '' : `, including ${nameList(named.map(nodeTitle))}`;
    builder.add(`${label}, other ends linked to ${anchor.title}: ${countWords(entry.count)}${including}.`, [result.ref, ...named.map((node) => node.ref)]);
  }
  return builder.finish();
}

export function derivedEdgeListed(detail: DerivedEdgeDetail): ListedElements {
  const title = (ref: { readonly stableId: string }, end: { readonly title: string }): string => (end.title.trim() === '' ? ref.stableId : end.title);
  const items: Listed[] = [
    { element: detail.from.ref, type: detail.from.type, title: title(detail.from.ref, detail.from) },
    { element: detail.to.ref, type: detail.to.type, title: title(detail.to.ref, detail.to) },
    { element: detail.ref, type: detail.type, title: `${detail.type}: ${title(detail.from.ref, detail.from)} → ${title(detail.to.ref, detail.to)}` },
  ];
  for (const group of detail.supports.groups) {
    for (const support of group.supports) {
      items.push({ element: support.ref, type: support.type, title: `${support.type}: ${title(support.from.ref, support.from)} → ${title(support.to.ref, support.to)}` });
    }
  }
  return listOf(items);
}

export function summarizeDerivedEdge(detail: DerivedEdgeDetail): ReturnType<SummaryBuilder['finish']> {
  const listed = derivedEdgeListed(detail);
  const builder = new SummaryBuilder(listed);
  const from = listed.get(refId(detail.from.ref))?.title ?? detail.from.ref.stableId;
  const to = listed.get(refId(detail.to.ref))?.title ?? detail.to.ref.stableId;
  builder.add(`${from} and ${to} are linked by rule ${detail.rule.id} (version ${detail.rule.version}).`, [detail.from.ref, detail.to.ref, detail.ref]);
  builder.add(`Supporting chains: ${countWords(detail.supports.count)}.`, [detail.ref]);
  return builder.finish();
}
