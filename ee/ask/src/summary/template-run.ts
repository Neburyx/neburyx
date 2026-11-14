import type { ElementRef, GraphNode, TemplateRunOk } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { SHOWN_NAMES, addNamed, edgeItem, nameList, nodeItem, nodeMap } from './shared.js';
import { nodeTitle, refId } from './title.js';

export function templateRunListed(run: TemplateRunOk): ListedElements {
  const nodes = nodeMap(run.nodes);
  return listOf([...run.nodes.map(nodeItem), ...run.edges.map((edge) => edgeItem(edge, nodes))]);
}

/** The anchor of a run: the node of the run's anchor when the result lists it, or else the first node it lists. */
function anchorOf(run: TemplateRunOk, anchor: ElementRef | undefined): GraphNode | undefined {
  return (anchor === undefined ? undefined : run.nodes.find((node) => refId(node.ref) === refId(anchor))) ?? run.nodes[0];
}

/**
 * The sentence that names the matches reached through an entity the result lists: the named matches whose link goes through one, taken in order while the middle entities they name together stay within a limit (five, then three, then one),
 * so a match is never paired with a middle entity that is not its own; the middles are those of the kept matches only. The limit shrinks when the sentence would pass the length limit.
 */
export function addReachedThrough(builder: SummaryBuilder, reached: readonly { readonly match: GraphNode; readonly through: readonly GraphNode[] }[]): void {
  const candidates = reached.filter((entry) => entry.through.length > 0);
  const first = candidates[0];
  if (first === undefined) return;
  const attempts = [SHOWN_NAMES, 3, 1].map((limit) => {
    const middles = new Map<string, GraphNode>();
    const kept: GraphNode[] = [];
    for (const entry of candidates) {
      const fresh = entry.through.filter((node) => !middles.has(refId(node.ref)));
      if (middles.size + fresh.length > limit) break;
      for (const node of fresh) middles.set(refId(node.ref), node);
      kept.push(entry.match);
    }
    // the first match alone may name more middles than the limit: it is then kept with the first of them, which is true of it
    const via = kept.length === 0 ? [first.through[0] as GraphNode] : [...middles.values()];
    const named = kept.length === 0 ? [first.match] : kept;
    return { named, via, text: `${nameList(named.map(nodeTitle))} ${named.length === 1 ? 'is' : 'are'} reached through ${nameList(via.map(nodeTitle))}.` };
  });
  const chosen = attempts.find((attempt) => builder.fits(attempt.text)) ?? attempts[attempts.length - 1];
  if (chosen === undefined) return;
  builder.add(chosen.text, [...chosen.named.map((node) => node.ref), ...chosen.via.map((node) => node.ref)]);
}

/** The summary of a shared-attribute or a linked-entities run: one sentence that names the matches (the count and the notices are drawn by the application), and one more for the matches reached through an entity. `anchor` is the run's own anchor, when the caller has it. */
export function summarizeTemplateRun(run: TemplateRunOk, anchor?: ElementRef): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(templateRunListed(run));
  const nodes = nodeMap(run.nodes);
  const head = anchorOf(run, anchor);
  if (head === undefined) return undefined;
  const linked = run.templateId === 'linked-entities';
  const title = nodeTitle(head);
  const matches = run.matchIds.map((ref) => nodes.get(refId(ref))).filter((node): node is GraphNode => node !== undefined);
  const shown = matches.slice(0, SHOWN_NAMES);
  if (run.count.quality === 'exact' && run.count.value === 0) {
    builder.add(linked ? `${title} reaches no other entity.` : `No other record shares an attribute with ${title}.`, [head.ref]);
    return builder.finish();
  }
  const complete = run.count.quality === 'exact' && run.count.value === matches.length && matches.length <= SHOWN_NAMES;
  addNamed(
    builder,
    linked
      ? (list, _count, whole) => (whole ? `${title} reaches ${list}.` : `${title} reaches, among others, ${list}.`)
      : (list, count, whole) => (whole ? `${list} ${count === 1 ? 'shares' : 'share'} an attribute with ${title}.` : `The records that share an attribute with ${title} include ${list}.`),
    shown.map((node) => ({ title: nodeTitle(node), ref: node.ref })),
    complete,
    [head.ref],
  );
  if (linked) {
    addReachedThrough(
      builder,
      shown.map((match) => ({
        match,
        through: (run.links ?? []).flatMap((link) => (refId(link.match) === refId(match.ref) && link.through !== undefined ? [nodes.get(refId(link.through))] : [])).filter((node): node is GraphNode => node !== undefined),
      })),
    );
  }
  // the count of a run is of the matches it holds: exact when the read ended, a lower bound when it was cut, so the line says what is shown and, for a cut, that more may exist
  const shownCount = run.matchIds.length;
  const omissions = run.count.quality === 'lowerBound' ? `${shownCount} shown; more may exist (lower bound).` : `${shownCount} shown.`;
  return builder.finish(omissions);
}
