import { useEffect, useRef, useState } from 'react';
import type { PatternDefinition } from '@neburyx/contracts';
import { RUN_COPY, elapsedText } from './run-copy.js';

interface Props {
  /** "name · Type · ID", or without the ID where it may not be shown. */
  readonly startLine: string;
  readonly startName: string;
  readonly definition: PatternDefinition;
  readonly nameOf: (type: string) => string;
  readonly onCancel: () => void;
}

/** The seconds since the screen showed, ticking once a second. */
function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}

/** A run on its way: where it starts, an indeterminate bar, the seconds elapsed and Cancel run, focused. There are no counts and no per-step progress, because none is known until the run finishes. */
export function RunningScreen({ startLine, startName, definition, nameOf, onCancel }: Props) {
  const seconds = useElapsed();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <>
      <div className="run-body" aria-busy="true">
        <div className="run-card">
          <p className="run-label">{RUN_COPY.startingFrom}</p>
          <p className="run-strong">{startLine}</p>
        </div>
        <p className="visually-hidden" role="status">
          {RUN_COPY.runningStatus}
        </p>
        <div className="run-bar" role="progressbar" aria-label={RUN_COPY.runningTitle}>
          <span />
        </div>
        <p className="search-panel-note">{elapsedText(seconds)}</p>
        <ul className="run-steps" aria-label="Steps">
          <li>
            {RUN_COPY.start} · {startName}
          </li>
          {definition.steps.map((step, index) => (
            <li key={index}>
              Step {index + 1} · {step.relationshipTypes.join(' or ')} → {nameOf(step.arrivesAt)}
            </li>
          ))}
        </ul>
        <div className="run-card">
          <p className="run-strong">{RUN_COPY.noCounts}</p>
          <p>{RUN_COPY.noCountsLine}</p>
        </div>
        <p className="search-panel-note">{RUN_COPY.cancelNote}</p>
      </div>
      <div className="run-footer">
        <button type="button" className="secondary" ref={cancel} onClick={onCancel}>
          {RUN_COPY.cancelRun}
        </button>
      </div>
    </>
  );
}

