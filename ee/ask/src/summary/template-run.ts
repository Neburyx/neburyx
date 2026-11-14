import type { ElementRef, GraphNode, TemplateRunOk } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { countWords } from './counts.js';
import { noticeSentence } from './notices.js';
import { SHOWN_NAMES, edgeItem, nameList, nodeItem, nodeMap, plural } from './shared.js';
import { nodeTitle, refId } from './title.js';

export function templateRunListed(run: TemplateRunOk): ListedElements {
  const nodes = nodeMap(run.nodes);
  return listOf([...run.nodes.map(nodeItem), ...run.edges.map((edge) => edgeItem(edge, nodes))]);
}

/** The anchor of a run: the node of the plan's anchor when the result lists it, or else the first node it lists. */
function anchorOf(run: TemplateRunOk, anchor: ElementRef | undefined): GraphNode | undefined {
  return (anchor === undefined ? undefined : run.nodes.find((node) => refId(node.ref) === refId(anchor))) ?? run.nodes[0];
}

/** The summary of a shared-attribute or a linked-entities run. `anchor` is the plan's own anchor, when the caller has it. */
export function summarizeTemplateRun(run: TemplateRunOk, anchor?: ElementRef): ReturnType<SummaryBuilder['finish']> {
  const listed = templateRunListed(run);
  const builder = new SummaryBuilder(listed);
  const nodes = nodeMap(run.nodes);
  const head = anchorOf(run, anchor);
  if (head === undefined) return undefined;
  const linked = run.templateId === 'linked-entities';
  const matches = run.matchIds.map((ref) => nodes.get(refId(ref))).filter((node): node is GraphNode => node !== undefined);
  const shown = matches.slice(0, SHOWN_NAMES);
  if (run.count.quality === 'exact' && run.count.value === 0) {
    builder.add(linked ? `${nodeTitle(head)} reaches no other entity.` : `No other record shares an attribute with ${nodeTitle(head)}.`, [head.ref]);
  } else {
    builder.add(linked ? `Entities reached from ${nodeTitle(head)}: ${countWords(run.count)}.` : `Other records that share an attribute with ${nodeTitle(head)}: ${countWords(run.count)}.`, [head.ref]);
    if (shown.length > 0) builder.add(`${plural(shown.length, 'It is', 'They are')} ${nameList(shown.map(nodeTitle))}.`, shown.map((node) => node.ref));
    if (linked) {
      for (const link of (run.links ?? []).slice(0, SHOWN_NAMES)) {
        const match = nodes.get(refId(link.match));
        if (match === undefined) continue;
        const through = link.through === undefined ? undefined : nodes.get(refId(link.through));
        const how = link.hops === 1 ? 'one hop' : through === undefined ? 'two hops' : `two hops, through ${nodeTitle(through)}`;
        builder.add(`${nodeTitle(match)} is reached in ${how}.`, through === undefined ? [match.ref] : [match.ref, through.ref]);
      }
    }
  }
  for (const notice of run.notices) {
    const text = noticeSentence(notice);
    if (text === undefined) continue;
    const named = notice.code === 'supernodesSkipped' ? notice.entities.filter((entity) => nodes.has(refId(entity))) : [];
    builder.add(text, named.length > 0 ? named : [head.ref]);
  }
  // the count of a run is of the matches it holds: exact when the read ended, a lower bound when it was cut, so the line says what is shown and, for a cut, that more may exist
  const shownCount = run.matchIds.length;
  const omissions = run.count.quality === 'lowerBound' ? `${shownCount} shown; more may exist (lower bound).` : run.count.quality === 'exact' && run.count.value === 0 ? undefined : `${shownCount} shown.`;
  return builder.finish(omissions);
}
