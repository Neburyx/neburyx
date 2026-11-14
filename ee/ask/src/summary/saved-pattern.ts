import type { AskRunResult, ElementRef, GraphNode, PatternRunOk } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { groupedNumber, remainderSentence } from './counts.js';
import { SHOWN_NAMES, addNamed, edgeItem, nodeItem, nodeMap } from './shared.js';
import { addReachedThrough, summarizeTemplateRun, templateRunListed } from './template-run.js';
import { nodeTitle, refId } from './title.js';

type SavedPatternResult = Extract<AskRunResult, { templateId: 'saved-pattern' }>['result'];

const isPatternRun = (result: SavedPatternResult): result is PatternRunOk => 'matches' in result;

function patternRunListed(run: PatternRunOk): ListedElements {
  const nodes = nodeMap(run.nodes);
  return listOf([...run.nodes.map(nodeItem), ...run.edges.map((edge) => edgeItem(edge, nodes))]);
}

/** The elements a result of a saved pattern lists: the nodes and relationships of a pattern run, or of the template run a saved preset made. A result that stopped as heavy lists nothing. */
export function savedPatternListed(result: SavedPatternResult): ListedElements | undefined {
  if (result.status !== 'ok') return undefined;
  return isPatternRun(result) ? patternRunListed(result) : templateRunListed(result);
}

/** The start the summary names: the node of the plan's own anchor when the result lists it, or else the entity the first hop of the first match leaves from, when the result lists that. Never a guess. */
function startOf(run: PatternRunOk, anchor: ElementRef | undefined, nodes: ReadonlyMap<string, GraphNode>): GraphNode | undefined {
  if (anchor !== undefined) {
    const named = nodes.get(refId(anchor));
    if (named !== undefined) return named;
  }
  const from = run.matches[0]?.relationships[0]?.from;
  return from === null || from === undefined ? undefined : nodes.get(refId(from));
}

/** The summary of a run of a saved pattern, by fixed rules from the result alone: one sentence that names the matches (the count and the notices are drawn by the application), and one more for the matches reached through entities; a run of a saved preset is summarised as a run of its template is. `anchor` is the plan's own anchor, when it has one. */
export function summarizeSavedPattern(result: SavedPatternResult, anchor?: ElementRef): ReturnType<SummaryBuilder['finish']> {
  if (result.status !== 'ok') return undefined;
  if (!isPatternRun(result)) return summarizeTemplateRun(result, anchor);
  const builder = new SummaryBuilder(patternRunListed(result));
  const nodes = nodeMap(result.nodes);
  const head = startOf(result, anchor, nodes);
  const listedMatches = result.matches.flatMap((entry) => {
    const node = nodes.get(refId(entry.match));
    return node === undefined ? [] : [{ entry, node }];
  });
  const shown = listedMatches.slice(0, SHOWN_NAMES);
  if (result.count.quality === 'exact' && result.count.value === 0) {
    if (head === undefined) return undefined;
    builder.add(`No match was found for the saved pattern from ${nodeTitle(head)}.`, [head.ref]);
    return builder.finish();
  }
  const from = head === undefined ? '' : ` from ${nodeTitle(head)}`;
  const complete = result.count.quality === 'exact' && result.count.value === listedMatches.length && listedMatches.length <= SHOWN_NAMES;
  addNamed(
    builder,
    (list, count, whole) => (whole ? `${list} ${count === 1 ? 'matches' : 'match'} the saved pattern${from}.` : `The matches of the saved pattern${from} include ${list}.`),
    shown.map(({ node }) => ({ title: nodeTitle(node), ref: node.ref })),
    complete,
    head === undefined ? [] : [head.ref],
  );
  addReachedThrough(
    builder,
    shown.map(({ entry, node }) => ({
      match: node,
      through: entry.through.flatMap((ref) => {
        const listed = ref === null ? undefined : nodes.get(refId(ref));
        return listed === undefined ? [] : [listed];
      }),
    })),
  );
  const done = result.count.quality === 'exact' && result.count.value !== undefined && result.count.value <= result.matches.length;
  return builder.finish(done ? `${groupedNumber(result.matches.length)} shown.` : remainderSentence(result.count, result.matches.length));
}
