import type { AssistantThreadResponse } from '@neburyx/contracts';
import { ASSISTANT_COPY, causeText, earlierText, sourcesText } from './copy.js';

export function StandingNote() {
  return <p className="ask-note assistant-standing">{ASSISTANT_COPY.standing}</p>;
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

const routeTag = (route: AssistantThreadResponse['turns'][number]['route']): string => (route === 'ask' ? ASSISTANT_COPY.routeAsk : route === 'view' ? ASSISTANT_COPY.routeView : ASSISTANT_COPY.routeRefuse);

export function StoredTurns({ turns, earlier }: { readonly turns: AssistantThreadResponse['turns']; readonly earlier: number }) {
  return (
    <section className="assistant-stored" aria-labelledby="assistant-stored-heading">
      <h3 id="assistant-stored-heading" className="assistant-stored-heading">
        {ASSISTANT_COPY.storedHeading}
      </h3>
      {earlier > 0 ? <p className="ask-note">{earlierText(earlier)}</p> : null}
      <ol className="assistant-stored-list">
        {turns.map((turn) => (
          <li key={turn.seq} className="assistant-stored-row" aria-label={`${routeTag(turn.route)}, ${turn.outcome === 'answered' ? ASSISTANT_COPY.storedAnswered : ASSISTANT_COPY.storedRefused}`}>
            <span className="assistant-tag">{routeTag(turn.route)}</span>
            <span className="assistant-stored-what">{turn.intent ?? (turn.cause === undefined ? '' : causeText(turn.cause))}</span>
            <span className="assistant-stored-end">{turn.outcome === 'answered' ? ASSISTANT_COPY.storedAnswered : ASSISTANT_COPY.storedRefused}</span>
            <span className="assistant-stored-count">{sourcesText(turn.citedElements)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
