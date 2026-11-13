import { useEffect, useRef } from 'react';
import type { PatternRunHeavy } from '@neburyx/contracts';
import { RUN_COPY, continueLine, pausedHeadline, pausedLine } from './run-copy.js';
import { continueWith } from '../../banner/copy.js';

interface Props {
  readonly heavy: PatternRunHeavy;
  readonly startName: string;
  readonly onRefine: () => void;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}

/** The run that stopped before reading matches: the estimate as a lower bound, the two choices and Cancel. The number is the answer's own: the estimate, or the threshold the stop was made at. */
export function HeavyScreen({ heavy, startName, onRefine, onContinue, onCancel }: Props) {
  const count = heavy.estimate.value ?? heavy.threshold;
  const headline = useRef<HTMLParagraphElement>(null);
  useEffect(() => headline.current?.focus(), []);
  return (
    <>
      <div className="run-body">
        <div className="patterns-state" data-tone="warning" role="alert">
          <p className="run-strong" tabIndex={-1} ref={headline}>
            {pausedHeadline(count)}
          </p>
          <p className="run-chips">
            <span className="run-chip">{RUN_COPY.estimated}</span>
            <span className="run-chip">{RUN_COPY.lowerBound}</span>
          </p>
          <p>{pausedLine(startName)}</p>
        </div>
        <p className="run-label">{RUN_COPY.choose}</p>
        <div className="run-choice">
          <p className="run-strong">{RUN_COPY.refine}</p>
          <p>{RUN_COPY.refineLine}</p>
        </div>
        <div className="run-choice" data-primary="true">
          <p className="run-strong">{continueWith(heavy.continueLimit)}</p>
          <p>{continueLine(heavy.continueLimit, count)}</p>
        </div>
        <p className="search-panel-note">{RUN_COPY.heavyStopped}</p>
      </div>
      <div className="run-footer">
        <button type="button" className="link" onClick={onCancel}>
          {RUN_COPY.cancel}
        </button>
        <button type="button" className="secondary" onClick={onRefine}>
          {RUN_COPY.refine}
        </button>
        <button type="button" className="primary" onClick={onContinue}>
          {continueWith(heavy.continueLimit)}
        </button>
      </div>
    </>
  );
}
