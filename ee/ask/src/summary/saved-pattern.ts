import type { AskRunResult, ElementRef, GraphNode, PatternRunOk } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { countWords, groupedNumber, remainderSentence } from './counts.js';
import { noticeSentence } from './notices.js';
import { SHOWN_NAMES, edgeItem, nameList, nodeItem, nodeMap, plural } from './shared.js';
import { summarizeTemplateRun, templateRunListed } from './template-run.js';
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

/** The summary of a run of a saved pattern, by fixed rules from the result alone: a run of a saved preset is summarised as a run of its template is. `anchor` is the plan's own anchor, when it has one. */
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
  const cite = head?.ref ?? shown[0]?.node.ref;
  const addNotices = (): void => {
    for (const notice of result.notices) {
      const text = noticeSentence(notice);
      if (text === undefined) continue;
      const named = notice.code === 'supernodesSkipped' ? notice.entities.filter((entity) => nodes.has(refId(entity))) : [];
      const cited = named.length > 0 ? named : cite === undefined ? [] : [cite];
      if (cited.length > 0) builder.add(text, cited);
    }
  };
  if (result.count.quality === 'exact' && result.count.value === 0) {
    if (head === undefined) return undefined;
    builder.add(`No match was found for the saved pattern from ${nodeTitle(head)}.`, [head.ref]);
    addNotices();
    return builder.finish();
  }
  if (cite !== undefined) builder.add(`Matches of the saved pattern${head === undefined ? '' : ` from ${nodeTitle(head)}`}: ${countWords(result.count)}.`, [cite]);
  if (shown.length > 0) builder.add(`${plural(shown.length, 'It is', 'They are')} ${nameList(shown.map(({ node }) => nodeTitle(node)))}.`, shown.map(({ node }) => node.ref));
  // when every shown match is one step away the count and the names say it all; a longer path is worth a sentence for each match
  const paths = shown.some(({ entry }) => entry.hops > 1) ? shown : [];
  for (const { entry, node } of paths) {
    const middle = entry.through.flatMap((ref) => {
      const listed = ref === null ? undefined : nodes.get(refId(ref));
      return listed === undefined ? [] : [listed];
    });
    const how = entry.hops === 1 ? 'one step' : `${entry.hops} steps`;
    builder.add(`${nodeTitle(node)} is reached in ${how}${middle.length === 0 ? '' : `, through ${nameList(middle.map(nodeTitle))}`}.`, [node.ref, ...middle.map((listed) => listed.ref)]);
  }
  addNotices();
  const complete = result.count.quality === 'exact' && result.count.value !== undefined && result.count.value <= result.matches.length;
  return builder.finish(complete ? `${groupedNumber(result.matches.length)} shown.` : remainderSentence(result.count, result.matches.length));
}
