import type { TemplateRunOk } from '@neburyx/contracts';
import { degreeCountText } from '../workspace/degree-text.js';
import { elementKey } from '../state/keys.js';
import { addedText, noticeText, PATTERNS_COPY } from './copy.js';
import type { AddedOutcome } from './add-to-graph.js';

type Ref = TemplateRunOk['matchIds'][number];

const same = (left: Ref, right: Ref): boolean => elementKey(left) === elementKey(right);

/** The shared attribute nodes that tie a match to the anchor: the nodes the match has an edge to among the shown attribute nodes. */
function sharedOf(result: TemplateRunOk, match: Ref): readonly string[] {
  const titles = new Map(result.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const matchKey = elementKey(match);
  const shared: string[] = [];
  for (const edge of result.edges) {
    const other = elementKey(edge.from) === matchKey ? edge.to : elementKey(edge.to) === matchKey ? edge.from : undefined;
    if (other === undefined) continue;
    const title = titles.get(elementKey(other));
    if (title !== undefined && !result.matchIds.some((candidate) => same(candidate, other)) && !shared.includes(title)) shared.push(title);
  }
  return shared;
}

/** How a match of a linked-entities run was reached: its hops, and the entity it went through when there were two. */
function linkOf(result: TemplateRunOk, match: Ref, titles: ReadonlyMap<string, string>): string | undefined {
  const link = result.links?.find((candidate) => same(candidate.match, match));
  if (link === undefined) return undefined;
  const through = link.through === undefined ? undefined : titles.get(elementKey(link.through)) ?? link.through.stableId;
  return `${link.hops} ${link.hops === 1 ? 'hop' : 'hops'}${through === undefined ? '' : ` via ${through}`}`;
}

/** The count with its quality in the words of the UI, and the table of matches with what they share, the notices and the evidence references. */
export interface AddControl {
  /** `onCanvas`: everything of the result is already loaded; `running`: a run is in flight; `ready`: the result can be added. */
  readonly state: 'ready' | 'onCanvas' | 'running';
  readonly disabled: boolean;
  readonly onAdd: () => void;
}

export function PatternResult({ result, matchHeading, sharedHeading, add, added, evidenceOpener }: { readonly result: TemplateRunOk; readonly matchHeading: string; readonly sharedHeading: string; readonly add?: AddControl; readonly added?: AddedOutcome; readonly evidenceOpener?: (reference: string) => (() => void) | undefined }) {
  const titles = new Map(result.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const evidence = [...new Set(result.edges.flatMap((edge) => edge.evidenceRefs))];
  return (
    <section className="patterns-result" aria-label={PATTERNS_COPY.result}>
      <p className="patterns-summary" role="status">
        {result.matchIds.length === 0 ? PATTERNS_COPY.noMatches : null}
        {result.matchIds.length === 0 ? ' ' : null}
        {degreeCountText(result.count)}
      </p>
      {result.matchIds.length === 0 || add === undefined ? null : (
        <div className="patterns-actions">
          <button type="button" className="primary" disabled={add.disabled} onClick={add.onAdd} {...(add.state === 'running' ? { 'aria-describedby': 'patterns-run-in-progress' } : {})}>
            {add.state === 'onCanvas' ? PATTERNS_COPY.onCanvas : PATTERNS_COPY.addToGraph}
          </button>
          {add.state === 'running' ? <span id="patterns-run-in-progress" className="search-panel-note">{PATTERNS_COPY.runInProgress}</span> : null}
        </div>
      )}
      {added === undefined ? null : (
        <p className="patterns-state" role="status">
          {addedText(added, result.count)}
        </p>
      )}
      {result.matchIds.length === 0 ? null : (
        <table className="patterns-table">
          <thead>
            <tr>
              <th scope="col">{matchHeading}</th>
              <th scope="col">{sharedHeading}</th>
            </tr>
          </thead>
          <tbody>
            {result.matchIds.map((match) => (
              <tr key={elementKey(match)}>
                <td>{titles.get(elementKey(match)) ?? match.stableId}</td>
                <td>
                  {linkOf(result, match, titles) ?? sharedOf(result, match).map((title) => <div key={title}>{title}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {evidence.length === 0 ? null : (
        <p className="search-panel-note">
          {PATTERNS_COPY.evidence}:{' '}
          {evidence.map((reference, index) => {
            const open = evidenceOpener?.(reference);
            return (
              <span key={reference}>
                {index === 0 ? '' : ', '}
                {open === undefined ? reference : (
                  <button type="button" className="link" onClick={open}>
                    {reference}
                  </button>
                )}
              </span>
            );
          })}
        </p>
      )}
      {result.notices.map((notice, index) => (
        <p className="search-panel-note" key={`${notice.code}-${index}`}>
          {noticeText(notice)}
        </p>
      ))}
    </section>
  );
}
