import type { EdgeRef, GraphNode, SearchResult } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type Listed, type ListedElements } from './core.js';
import { SHOWN_NAMES, addNamed, nodeItem, nodeMap } from './shared.js';
import { endTitle, nodeTitle } from './title.js';

type EvidenceHit = SearchResult['evidence']['hits'][number];

function nodesOf(result: SearchResult): Map<string, GraphNode> {
  return nodeMap([...result.exact, ...result.related.hits.map((hit) => hit.node)]);
}

/** A stored hit's ends are only entity types, so its title is its type, the two end types and its own stable ID; an aggregate's ends are references, named by the listed node or the stable ID. */
function evidenceItem(result: SearchResult, hit: EvidenceHit, nodes: ReadonlyMap<string, GraphNode>): Listed {
  if ('supports' in hit) return { element: hit.supports, type: hit.supports.type, title: `${hit.supports.type}: ${hit.supports.from} → ${hit.supports.to} (${hit.supports.stableId})` };
  const element: EdgeRef = { sourceId: result.sourceId, aggregate: hit.aggregate };
  return { element, type: hit.aggregate.type, title: `${hit.aggregate.type}: ${endTitle(hit.aggregate.from, nodes)} → ${endTitle(hit.aggregate.to, nodes)}` };
}

export function searchListed(result: SearchResult): ListedElements {
  const nodes = nodesOf(result);
  return listOf([...result.exact.map(nodeItem), ...result.related.hits.map((hit) => nodeItem(hit.node)), ...result.evidence.hits.map((hit) => evidenceItem(result, hit, nodes))]);
}

/** A search lists nothing to cite when no group holds a hit with a reference: then there is no summary. Nothing typed, no matched property, no context and no record is ever repeated. */
export function summarizeSearch(result: SearchResult): ReturnType<SummaryBuilder['finish']> {
  const listed = searchListed(result);
  const first = [...listed.values()][0];
  if (first === undefined) return undefined;
  const builder = new SummaryBuilder(listed);
  addNamed(builder, (list) => `Exact matches include ${list}.`, result.exact.slice(0, SHOWN_NAMES).map((node) => ({ title: nodeTitle(node), ref: node.ref })), false);
  addNamed(builder, (list) => `Related records include ${list}.`, result.related.hits.slice(0, SHOWN_NAMES).map((hit) => ({ title: nodeTitle(hit.node), ref: hit.node.ref })), false);
  addNamed(builder, (list) => `Supporting relationships include ${list}.`, result.evidence.hits.slice(0, SHOWN_NAMES).map((hit) => evidenceItem(result, hit, nodesOf(result))).map((item) => ({ title: item.title, ref: item.element })), false);
  for (const failure of result.failures) builder.add(`The ${failure.group} group could not be read.`, [first.element]);
  if (!result.searchable) builder.add('No property could be searched.', [first.element]);
  else {
    if (!result.related.searchable) builder.add('The related records could not be searched.', [first.element]);
    if (!result.evidence.searchable) builder.add('The supporting relationships could not be searched.', [first.element]);
  }
  return builder.finish();
}
