import type { AskSummary, FileQueryResult } from '@neburyx/contracts';
import { SummaryBuilder, citedKeysExist, listOf, type ListedElements } from './core.js';
import { countWords, groupedNumber, remainderSentence } from './counts.js';
import { noticeSentence } from './notices.js';
import { SHOWN_NAMES, edgeItem, nameList, nodeItem, nodeMap, plural } from './shared.js';
import { nodeTitle } from './title.js';
import type { SummaryOutcome } from './index.js';

/** The elements a file-query result lists, which a citation may name: its nodes and its relationships. */
export function fileQueryListed(result: FileQueryResult): ListedElements {
  const nodes = nodeMap(result.nodes);
  return listOf([...result.nodes.map(nodeItem), ...result.edges.map((edge) => edgeItem(edge, nodes))]);
}

/**
 * The summary of a file-query result, by fixed rules from the result alone (no model, no read, no clock): the count of rows with its label, the names of up to five nodes, how many relationships of how many types, the
 * sentences of its notices and the omissions line; every sentence cites elements the result lists. A result that lists no node has no summary, because a sentence must cite an element.
 */
export function summarizeFileQuery(result: FileQueryResult): AskSummary | undefined {
  const [first] = result.nodes;
  if (first === undefined) return undefined;
  const builder = new SummaryBuilder(fileQueryListed(result));
  const shown = result.nodes.slice(0, SHOWN_NAMES);
  builder.add(`Rows returned by the query: ${countWords(result.count)}.`, [first.ref]);
  builder.add(`${plural(shown.length, 'It is', 'They are')} ${nameList(shown.map(nodeTitle))}.`, shown.map((node) => node.ref));
  if (result.edges.length > 0) {
    const types = [...new Set(result.edges.map((edge) => edge.type))];
    builder.add(`${groupedNumber(result.edges.length)} ${plural(result.edges.length, 'relationship is', 'relationships are')} shown, of ${groupedNumber(types.length)} ${plural(types.length, 'type', 'types')}.`, result.edges.slice(0, SHOWN_NAMES).map((edge) => edge.ref));
  }
  for (const notice of result.notices) {
    const text = noticeSentence(notice);
    if (text !== undefined) builder.add(text, [first.ref]);
  }
  const rows = result.count.value ?? 0;
  const complete = result.count.quality === 'exact';
  return builder.finish(complete ? `${groupedNumber(rows)} shown.` : remainderSentence(result.count, rows));
}

/** The summary of a file-query result with its own check: a summary whose citations the result does not list is reported as failed, never returned. */
export function summarizeFileQueryResult(result: FileQueryResult): SummaryOutcome {
  const summary = summarizeFileQuery(result);
  if (summary === undefined) return { kind: 'none' };
  return citedKeysExist(summary, fileQueryListed(result)) ? { kind: 'summary', summary } : { kind: 'check-failed' };
}
