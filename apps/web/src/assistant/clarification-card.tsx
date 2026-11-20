import { useId } from 'react';
import { humanize } from '../ask/text.js';
import { ASSISTANT_COPY } from './copy.js';
import type { ClarificationCandidate } from './assistant-session.js';

export function ClarificationCard({
  question,
  candidates,
  onPick,
  onCancel,
}: {
  readonly question: string;
  readonly candidates: readonly ClarificationCandidate[];
  readonly onPick: (index: number) => void;
  readonly onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <section
      className="assistant-clarify"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <h3 id={titleId} tabIndex={-1} data-ask-focus="title">
        {ASSISTANT_COPY.clarifyTitle}
      </h3>
      <p>{question}</p>
      <ul className="assistant-clarify-list" aria-label={ASSISTANT_COPY.clarifyCandidates}>
        {candidates.map((candidate, index) => (
          <li key={index}>
            <button type="button" className="assistant-clarify-row" onClick={() => onPick(index)}>
              <span className="assistant-clarify-name">{candidate.title}</span>
              <span className="assistant-clarify-type">{humanize(candidate.type)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ask-continue ask-send-cancel" onClick={onCancel}>
        {ASSISTANT_COPY.cancel}
      </button>
      <p className="ask-note">{ASSISTANT_COPY.clarifyStatus}</p>
    </section>
  );
}
