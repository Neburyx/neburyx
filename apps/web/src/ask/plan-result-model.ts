import type { AskRunResult, Count, GraphEdge, GraphNode } from '@neburyx/contracts';
import { noticeText } from '../patterns/copy.js';
import { degreeCountText } from '../workspace/degree-text.js';

/** What a result gives the graph: its nodes and edges and the template it came from, for `addResultToGraph`; nothing for a result that lists no node to draw. */
export interface Addable {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly templateId: string;
}

interface ResultLine {
  readonly label: string;
  readonly text: string;
}

export interface ResultView {
  readonly lines: readonly ResultLine[];
  readonly notices: readonly string[];
  readonly addable: Addable | undefined;
}

const countLine = (label: string, count: Count): ResultLine => ({ label, text: degreeCountText(count) });

/** The nodes and edges a result adds to the graph, or undefined when it lists none. */
export function addableOf(result: AskRunResult): Addable | undefined {
  switch (result.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
    case 'saved-pattern':
    case 'file-query':
      return result.result.status === 'ok' ? { nodes: result.result.nodes, edges: result.result.edges, templateId: result.templateId } : undefined;
    case 'entity':
      return { nodes: [result.result], edges: [], templateId: result.templateId };
    case 'expand':
      return { nodes: result.result.nodes, edges: result.result.edges, templateId: result.templateId };
    case 'derived-rule-run':
      return { nodes: result.result.results.flatMap((entry) => entry.nodes), edges: result.result.results.flatMap((entry) => entry.edges), templateId: result.templateId };
    case 'search':
      return { nodes: result.result.exact, edges: [], templateId: result.templateId };
    case 'degree-preview':
    case 'derived-edge-support':
      return undefined;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

/** A result in words: each count with its quality label as the manual route gave it (no number when it gave none), and the notices the run carries in the words of the patterns' results. */
export function resultView(result: AskRunResult): ResultView {
  const addable = addableOf(result);
  switch (result.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
    case 'saved-pattern':
      return result.result.status === 'ok'
        ? { lines: [countLine('Matches', result.result.count)], notices: result.result.notices.map(noticeText), addable }
        : { lines: [countLine('Estimate', result.result.estimate)], notices: result.result.notices.map(noticeText), addable };
    case 'file-query':
      return { lines: [countLine('Rows', result.result.count)], notices: result.result.notices.map(noticeText), addable };
    case 'entity':
      return { lines: [{ label: 'Entity', text: result.result.display.title === '' ? result.result.ref.stableId : result.result.display.title }], notices: [], addable };
    case 'degree-preview':
      return { lines: [countLine('Relationships', result.result.total), ...result.result.byType.map((entry) => countLine(`${entry.relationshipType} · ${entry.direction === 'out' ? 'outgoing' : 'incoming'}`, entry.count))], notices: [], addable };
    case 'expand':
      return {
        lines: result.result.pages.map((page) => ({ label: page.neighborType, text: `${page.returned} shown · ${degreeCountText(page.matchingTotal)}${page.hasMore ? ' · more on the next page' : ''}` })),
        notices: [],
        addable,
      };
    case 'derived-rule-run':
      return { lines: result.result.results.map((entry) => countLine(entry.ruleId, entry.count)), notices: [], addable };
    case 'derived-edge-support':
      return { lines: [countLine('Supports', result.result.supports.count)], notices: [], addable };
    case 'search':
      return {
        lines: [countLine('Exact matches', result.result.counts.exact), countLine('Related records', result.result.related.count), countLine('Supporting relationships', result.result.evidence.count)],
        notices: [],
        addable,
      };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}
