import type { AskRunResult, Count, GraphEdge, GraphNode } from '@neburyx/contracts';
import { noticeText } from '../patterns/copy.js';
import { pathCapText, pathCutText, pathTitle } from './copy.js';
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

/** The count of a result, with the noun it counts: drawn as a figure with its quality word. */
export interface CountFact {
  readonly count: Count;
  readonly noun: 'match' | 'row';
}

export interface ResultView {
  /** The lines of a result that has no count of its own to draw as a figure. */
  readonly lines: readonly ResultLine[];
  readonly count: CountFact | undefined;
  /** How many matches or rows the result lists: what Add to graph adds can be fewer than the count. */
  readonly listed: number | undefined;
  /** One line for each row a file query returned: the relationships as `from → type → to`, else the entities. */
  readonly rows: readonly string[];
  readonly notices: readonly string[];
  readonly addable: Addable | undefined;
  /** The paths of a path answer, each with its steps as `from → to`. */
  readonly paths?: readonly PathView[];
  /** What a path answer says of being cut, in place of the generic words of a partial result. */
  readonly cutText?: string | undefined;
}

interface PathView {
  readonly position: number;
  readonly title: string;
  readonly steps: readonly string[];
}

const titleOf = (nodes: readonly GraphNode[], ref: { readonly stableId: string; readonly entityType: string }): string => {
  const node = nodes.find((entry) => entry.ref.stableId === ref.stableId && entry.ref.entityType === ref.entityType);
  return node === undefined || node.display.title === '' ? ref.stableId : node.display.title;
};

/** The paths of a path answer: "Path N · k hops" with each step as the titles of its two ends. */
function pathsOf(answer: Extract<Extract<AskRunResult, { templateId: 'shortest-paths' }>['result'], { status: 'ok' }>): readonly PathView[] {
  return answer.paths.map((path, index) => ({ position: index + 1, title: pathTitle(index + 1, path.hops), steps: path.steps.map((step) => `${titleOf(answer.nodes, step.from)} → ${titleOf(answer.nodes, step.to)}`) }));
}

/** The rows of a file query: each relationship as `from → type → to`, and each entity no relationship names on a line of its own. */
function rowsOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): readonly string[] {
  const named = new Set(edges.flatMap((edge) => [`${edge.from.entityType}\u0000${edge.from.stableId}`, `${edge.to.entityType}\u0000${edge.to.stableId}`]));
  return [...edges.map((edge) => `${titleOf(nodes, edge.from)} → ${edge.type} → ${titleOf(nodes, edge.to)}`), ...nodes.filter((node) => !named.has(`${node.ref.entityType}\u0000${node.ref.stableId}`)).map((node) => (node.display.title === '' ? node.ref.stableId : node.display.title))];
}

/** The matches a run of a template lists; the count can be larger, as the page is. */
function listedOf(result: object): number | undefined {
  if ('matchIds' in result && Array.isArray(result.matchIds)) return result.matchIds.length;
  if ('matches' in result && Array.isArray(result.matches)) return result.matches.length;
  return undefined;
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
    case 'shortest-paths':
      return result.result.status === 'ok' ? { nodes: result.result.nodes, edges: result.result.edges, templateId: result.templateId } : undefined;
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
        ? { lines: [], count: { count: result.result.count, noun: 'match' }, listed: listedOf(result.result), rows: [], notices: result.result.notices.map(noticeText), addable }
        : { lines: [], count: { count: result.result.estimate, noun: 'match' }, listed: undefined, rows: [], notices: result.result.notices.map(noticeText), addable };
    case 'file-query':
      return { lines: [], count: { count: result.result.count, noun: 'row' }, listed: rowsOf(result.result.nodes, result.result.edges).length, rows: rowsOf(result.result.nodes, result.result.edges), notices: result.result.notices.map(noticeText), addable };
    case 'entity':
      return { lines: [{ label: 'Entity', text: result.result.display.title === '' ? result.result.ref.stableId : result.result.display.title }], count: undefined, listed: undefined, rows: [], notices: [], addable };
    case 'degree-preview':
      return { lines: [countLine('Relationships', result.result.total), ...result.result.byType.map((entry) => countLine(`${entry.relationshipType} · ${entry.direction === 'out' ? 'outgoing' : 'incoming'}`, entry.count))], count: undefined, listed: undefined, rows: [], notices: [], addable };
    case 'expand':
      return {
        lines: result.result.pages.map((page) => ({ label: page.neighborType, text: `${page.returned} shown · ${degreeCountText(page.matchingTotal)}${page.hasMore ? ' · more on the next page' : ''}` })),
        count: undefined,
        listed: undefined,
        rows: [],
        notices: [],
        addable,
      };
    case 'derived-rule-run':
      return { lines: result.result.results.map((entry) => countLine(entry.ruleId, entry.count)), count: undefined, listed: undefined, rows: [], notices: [], addable };
    case 'derived-edge-support':
      return { lines: [countLine('Supports', result.result.supports.count)], count: undefined, listed: undefined, rows: [], notices: [], addable };
    case 'shortest-paths':
      return result.result.status === 'ok'
        ? { lines: [{ label: 'Paths', text: `${result.result.paths.length} found` }], count: undefined, listed: undefined, rows: [], notices: [], addable, paths: pathsOf(result.result), cutText: result.result.partial ? pathCutText(result.result.retained ?? result.result.paths.length, result.result.requested ?? result.result.paths.length) : result.result.capReached ? pathCapText(result.result.paths.length) : undefined }
        : { lines: [], count: { count: result.result.estimate, noun: 'match' }, listed: undefined, rows: [], notices: [], addable };
    case 'search':
      return {
        lines: [countLine('Exact matches', result.result.counts.exact), countLine('Related records', result.result.related.count), countLine('Supporting relationships', result.result.evidence.count)],
        count: undefined,
        listed: undefined,
        rows: [],
        notices: [],
        addable,
      };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}
