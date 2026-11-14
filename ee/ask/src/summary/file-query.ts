import type { AskSummary, FileQueryResult } from '@neburyx/contracts';
import { SummaryBuilder, citedKeysExist, listOf, type ListedElements } from './core.js';
import { groupedNumber, remainderSentence } from './counts.js';
import { SHOWN_NAMES, addNamed, edgeItem, nodeItem, nodeMap } from './shared.js';
import { nodeTitle } from './title.js';
import type { SummaryOutcome } from './index.js';

/** The elements a file-query result lists, which a citation may name: its nodes and its relationships. */
export function fileQueryListed(result: FileQueryResult): ListedElements {
  const nodes = nodeMap(result.nodes);
  return listOf([...result.nodes.map(nodeItem), ...result.edges.map((edge) => edgeItem(edge, nodes))]);
}

/**
 * The summary of a file-query result, by fixed rules from the result alone (no model, no read, no clock): one sentence that names up to five nodes the query returned and, when relationships are listed, one that names their types (the counts and the notices are drawn
 * by the application); every sentence cites elements the result lists. A result that lists no node has no summary, because a sentence must cite an element.
 */
export function summarizeFileQuery(result: FileQueryResult): AskSummary | undefined {
  if (result.nodes.length === 0) return undefined;
  const builder = new SummaryBuilder(fileQueryListed(result));
  const shown = result.nodes.slice(0, SHOWN_NAMES);
  addNamed(
    builder,
    (list, _count, whole) => (whole ? `The query returned ${list}.` : `The rows include ${list}.`),
    shown.map((node) => ({ title: nodeTitle(node), ref: node.ref })),
    result.count.quality === 'exact' && result.count.value === result.nodes.length && result.nodes.length <= SHOWN_NAMES,
  );
  if (result.edges.length > 0) {
    const types = result.edges.filter((edge, index) => result.edges.findIndex((other) => other.type === edge.type) === index);
    const single = result.edges.length === 1;
    addNamed(
      builder,
      (list, count, whole) => (single ? `The relationship shown is of type ${list}.` : whole ? `The relationships shown are of type ${list}.` : `The relationships shown include the ${count === 1 ? 'type' : 'types'} ${list}.`),
      types.slice(0, SHOWN_NAMES).map((edge) => ({ title: edge.type, ref: edge.ref })),
      types.length <= SHOWN_NAMES,
    );
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
