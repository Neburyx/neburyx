import { useId, useState } from 'react';
import type { PatternMatch, PatternRunOk } from '@neburyx/contracts';
import { elementKey } from '../../state/keys.js';
import { edgesOfMatch, linesOf, partOf, pathOf } from './match-model.js';
import { RUN_COPY } from './run-copy.js';
import type { AddResult } from './use-add-matches.js';

interface Props {
  /** The place of the match among the matches of the run, from 1. */
  readonly number: number;
  readonly match: PatternMatch;
  readonly answer: PatternRunOk;
  readonly mask: boolean;
  readonly personal: (entityType: string) => readonly string[];
  readonly add: AddResult;
  readonly evidenceOpener: ((reference: string) => (() => void) | undefined) | undefined;
}

/** One match: its path as chips, the lines the answer carries for it, the evidence of its relationships, and Add to graph (or On the graph once its entities and relationships are there). */
export function MatchCard({ number, match, answer, mask, personal, add, evidenceOpener }: Props) {
  const [open, setOpen] = useState(false);
  const evidenceId = useId();
  const part = partOf(match, answer);
  const onGraph = add.onGraph(part);
  const lines = linesOf(match, answer, mask, personal);
  const titles = new Map(answer.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const titleOf = (ref: PatternMatch['match']): string => titles.get(elementKey(ref)) ?? (mask ? RUN_COPY.hiddenEntity : ref.stableId);
  const withEvidence = edgesOfMatch(match, answer).filter((edge) => edge.evidenceRefs.length > 0);
  return (
    <li className="run-card run-match">
      <div className="run-match-head">
        <h4 className="run-strong">
          {RUN_COPY.match} {number}
        </h4>
        {onGraph ? <span className="run-chip run-chip-accent">{RUN_COPY.onGraph}</span> : null}
      </div>
      <ol className="run-path" aria-label={RUN_COPY.path}>
        {pathOf(match, answer, mask).map((part, index) => (
          <li key={index} className={part.kind === 'entity' ? 'run-chip run-path-entity' : 'run-path-relationship'} data-gap={part.kind === 'entity' && part.gap ? 'true' : undefined}>
            {part.kind === 'relationship' ? <span aria-hidden="true">→ </span> : null}
            {part.text}
            {part.kind === 'relationship' ? <span aria-hidden="true"> →</span> : null}
          </li>
        ))}
      </ol>
      {lines.length === 0 ? null : (
        <ul className="run-lines">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="run-evidence" id={evidenceId}>
          <p className="run-strong">{RUN_COPY.evidence}</p>
          {withEvidence.length === 0 ? <p>{RUN_COPY.noEvidence}</p> : null}
          <ul>
            {withEvidence.map((edge) => (
              <li key={elementKey(edge.from) + elementKey(edge.to) + edge.type + edge.evidenceRefs.join()}>
                <span className="run-mono">{edge.type}</span> {titleOf(edge.from)} → {titleOf(edge.to)}
                <br />
                {edge.evidenceRefs.map((reference, index) => {
                  const opener = evidenceOpener?.(reference);
                  return (
                    <span key={reference}>
                      {index === 0 ? '' : ', '}
                      {opener === undefined ? (
                        reference
                      ) : (
                        <button type="button" className="link" onClick={opener}>
                          {reference}
                        </button>
                      )}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="run-match-actions">
        <button type="button" className="link" aria-expanded={open} aria-controls={open ? evidenceId : undefined} onClick={() => setOpen((was) => !was)}>
          {RUN_COPY.evidence} <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {onGraph ? null : (
          <button type="button" className="secondary" disabled={!add.canAdd || add.running} aria-label={`${RUN_COPY.addToGraph}, ${RUN_COPY.match} ${number}`} onClick={() => add.add(part)}>
            {RUN_COPY.addToGraph}
          </button>
        )}
      </div>
    </li>
  );
}
