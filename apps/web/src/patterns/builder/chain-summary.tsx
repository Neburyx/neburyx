import { totalConditions } from './conditions.js';
import { BUILDER_COPY, DIRECTION_TEXT, EDITOR_COPY, chainTitle } from './copy.js';
import { ARROW } from '../copy.js';
import type { Draft } from './model.js';
import { isComplete } from './model.js';

interface Props {
  readonly draft: Draft;
  readonly nameOf: (type: string | undefined) => string;
  /** Whether the source has checked this very pattern and finds the mapping able to follow it. */
  readonly valid: boolean;
}

/** The chain on top of the editor, always in view: the start type, then each step as its relationship types and the type it arrives at, and the source's word when it has checked the pattern. */
export function ChainSummary({ draft, nameOf, valid }: Props) {
  return (
    <div className="pattern-chain">
      <p className="pattern-chain-title">{chainTitle(draft.steps.length, totalConditions(draft.steps))}</p>
      {draft.anchorType === undefined ? null : (
        <div className="pattern-path" role="group" aria-label={BUILDER_COPY.path}>
          <span className="pattern-chip pattern-chip-node">{nameOf(draft.anchorType)}</span>
          {draft.steps.map((step, index) => {
            const arrow = step.direction === undefined ? '→' : ARROW[step.direction];
            return (
              <span className="pattern-path-step" key={index} role="group" aria-label={step.direction === undefined ? `Step ${index + 1}` : `${DIRECTION_TEXT[step.direction]}: ${step.relationshipTypes.join(' or ')}`}>
                <span className="pattern-arrow" aria-hidden="true">
                  {arrow}
                </span>
                <span className="pattern-chip pattern-chip-rel">{step.relationshipTypes.length === 0 ? '…' : step.relationshipTypes.join(' / ')}</span>
                <span className="pattern-arrow" aria-hidden="true">
                  {arrow}
                </span>
                <span className="pattern-chip pattern-chip-node" data-complete={isComplete(step) ? 'true' : undefined}>
                  {step.arrivesAt === undefined ? '…' : nameOf(step.arrivesAt)}
                </span>
              </span>
            );
          })}
        </div>
      )}
      {draft.steps.length === 0 && draft.anchorType !== undefined ? <p className="pattern-chain-note">{EDITOR_COPY.addStepToContinue}</p> : null}
      {valid ? (
        <p className="pattern-chain-note" role="status" data-tone="good">
          <span aria-hidden="true">✓ </span>
          {EDITOR_COPY.canFollow}
        </p>
      ) : null}
    </div>
  );
}
