import { ASSISTANT_COPY } from './copy.js';

export function StandingNote() {
  return <p id="assistant-standing" className="visually-hidden">{ASSISTANT_COPY.standing}</p>;
}

export function NewThreadCard() {
  return (
    <section className="assistant-newthread" aria-labelledby="assistant-newthread-title">
      <div className="assistant-newthread-box">
        <p id="assistant-newthread-title" className="assistant-newthread-title">
          {ASSISTANT_COPY.newThreadTitle}
        </p>
        <p>{ASSISTANT_COPY.newThreadBody}</p>
      </div>
      <p className="ask-note">{ASSISTANT_COPY.newThreadNote}</p>
    </section>
  );
}

export function MaskingCard({ summary = false }: { readonly summary?: boolean }) {
  return (
    <div className="assistant-masking">
      <section className="ask-failure ask-failure-caution" role="status">
        <h3>{ASSISTANT_COPY.maskingTitle}</h3>
        <p>{summary ? ASSISTANT_COPY.maskingBodyWithSummary : ASSISTANT_COPY.maskingBody}</p>
      </section>
      <p className="ask-note">{summary ? ASSISTANT_COPY.maskingNoteWithSummary : ASSISTANT_COPY.maskingNote}</p>
    </div>
  );
}
