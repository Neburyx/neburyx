import { useId, useState } from 'react';
import { ASSISTANT_COPY } from './copy.js';
import type { AttachedSummary } from './assistant-session.js';

const timeOf = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(11, 16);

const metaOf = (summary: AttachedSummary): string => `${summary.sentences.length} ${summary.sentences.length === 1 ? 'sentence' : 'sentences'} · drafted ${timeOf(summary.arrivedAt)} UTC · ${ASSISTANT_COPY.modelTag}: ${summary.model}`;

/** The summary handed to the thread, as context: its first sentence, the rest on request, and that it is used for this thread only. */
export function SummaryContext({ summary }: { readonly summary: AttachedSummary }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const [first, ...rest] = summary.sentences;
  const refused = summary.status === 'invalid';
  return (
    <section className="assistant-summary-context" aria-label={ASSISTANT_COPY.summaryContext}>
      <div className="assistant-summary-head">
        <h3>{ASSISTANT_COPY.summaryContext}</h3>
        <span className="summary-tag">{refused ? ASSISTANT_COPY.summaryNoLonger : ASSISTANT_COPY.summaryContextTag}</span>
      </div>
      <p className="ask-note">{metaOf(summary)}</p>
      <p className="assistant-sentence">{first}</p>
      <div id={bodyId} hidden={!open}>
        {rest.map((sentence, index) => (
          <p key={index} className="assistant-sentence">
            {sentence}
          </p>
        ))}
      </div>
      {rest.length === 0 ? null : (
        <button type="button" className="summary-link" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {open ? 'Show fewer sentences' : `+ ${rest.length} more ${rest.length === 1 ? 'sentence' : 'sentences'}`}
        </button>
      )}
      <p className="ask-note">{ASSISTANT_COPY.summaryUsedFor}</p>
    </section>
  );
}
