import type { EdgeRef, ElementRef, GraphNode, SearchResult } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type Listed, type ListedElements } from './core.js';
import { countWords } from './counts.js';
import { SHOWN_NAMES, nameList, nodeItem, nodeMap } from './shared.js';
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
  const named: (ElementRef | EdgeRef)[] = result.exact.slice(0, SHOWN_NAMES).map((node) => node.ref);
  const exactNames = result.exact.slice(0, SHOWN_NAMES).map(nodeTitle);
  if (named.length > 0) builder.add(`Exact matches: ${countWords(result.counts.exact)}, including ${nameList(exactNames)}.`, named);
  const relatedNames = result.related.hits.slice(0, SHOWN_NAMES);
  if (relatedNames.length > 0) builder.add(`Related records: ${countWords(result.related.count)}, including ${nameList(relatedNames.map((hit) => nodeTitle(hit.node)))}.`, relatedNames.map((hit) => hit.node.ref));
  const evidence = result.evidence.hits.slice(0, SHOWN_NAMES).map((hit) => evidenceItem(result, hit, nodesOf(result)));
  if (evidence.length > 0) builder.add(`Supporting relationships: ${countWords(result.evidence.count)}, such as ${nameList(evidence.map((item) => item.title))}.`, evidence.map((item) => item.element));
  for (const failure of result.failures) builder.add(`The ${failure.group} group could not be read.`, [first.element]);
  if (!result.searchable) builder.add('No property could be searched.', [first.element]);
  else {
    if (!result.related.searchable) builder.add('The related records could not be searched.', [first.element]);
    if (!result.evidence.searchable) builder.add('The supporting relationships could not be searched.', [first.element]);
  }
  return builder.finish();
}
