import type { PatternMatch, PatternRunOk } from '@neburyx/contracts';
import { degreeCountText } from '../../workspace/degree-text.js';
import { elementKey } from '../../state/keys.js';
import { addedText, noticeText, PATTERNS_COPY } from '../copy.js';
import type { AddedOutcome } from '../add-to-graph.js';
import type { AddControl } from '../pattern-result.js';
import { RUN_COPY } from './run-copy.js';

interface Props {
  readonly result: PatternRunOk;
  readonly matchHeading: string;
  readonly add?: AddControl;
  readonly added?: AddedOutcome;
  readonly evidenceOpener?: (reference: string) => (() => void) | undefined;
}

/** The path that reached a match: the relationship of each hop and the entities between, a gap kept where an entity has no usable ID. */
function pathOf(match: PatternMatch, titles: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  match.relationships.forEach((hop, index) => {
    parts.push(hop.relationshipType ?? RUN_COPY.unusableRelationship);
    const between = match.through[index];
    if (index < match.through.length) parts.push(between === null || between === undefined ? RUN_COPY.gap : (titles.get(elementKey(between)) ?? between.stableId));
  });
  return parts.join(' → ');
}

/** The count with its quality in the words of the UI, the table of matches with the path of each, the notices and the evidence references of the run. */
export function DefinitionResult({ result, matchHeading, add, added, evidenceOpener }: Props) {
  const titles = new Map(result.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const evidence = [...new Set(result.edges.flatMap((edge) => edge.evidenceRefs))];
  return (
    <section className="patterns-result" aria-label={PATTERNS_COPY.result}>
      <p className="patterns-summary" role="status">
        {result.matches.length === 0 ? PATTERNS_COPY.noMatches : null}
        {result.matches.length === 0 ? ' ' : null}
        {degreeCountText(result.count)}
      </p>
      {result.matches.length === 0 || add === undefined ? null : (
        <div className="patterns-actions">
          <button type="button" className="primary" disabled={add.disabled} onClick={add.onAdd} {...(add.state === 'running' ? { 'aria-describedby': 'pattern-run-in-progress' } : {})}>
            {add.state === 'onCanvas' ? PATTERNS_COPY.onCanvas : PATTERNS_COPY.addToGraph}
          </button>
          {add.state === 'running' ? (
            <span id="pattern-run-in-progress" className="search-panel-note">
              {PATTERNS_COPY.runInProgress}
            </span>
          ) : null}
        </div>
      )}
      {added === undefined ? null : (
        <p className="patterns-state" role="status">
          {addedText(added, result.count)}
        </p>
      )}
      {result.matches.length === 0 ? null : (
        <table className="patterns-table">
          <thead>
            <tr>
              <th scope="col">{matchHeading}</th>
              <th scope="col">{RUN_COPY.path}</th>
            </tr>
          </thead>
          <tbody>
            {result.matches.map((match) => (
              <tr key={elementKey(match.match)}>
                <td>{titles.get(elementKey(match.match)) ?? match.match.stableId}</td>
                <td>{pathOf(match, titles)}</td>
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
                {open === undefined ? (
                  reference
                ) : (
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
