import { useEffect, useRef } from 'react';
import type { AiNotesResponse } from '@neburyx/contracts';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { utcDateTime } from '../views/format.js';
import { offersRetry } from '../failure-notice.js';
import { failureWords } from '../failure-words.js';
import { SUMMARY_COPY } from './copy.js';
import { useNotes, type NotesStage } from './use-notes.js';

type Entry = AiNotesResponse['entries'][number];
type Citation = Entry['sentences'][number]['citations'][number];

const keyOf = (citation: Citation): string => ('entityType' in citation.ref ? elementKey(citation.ref) : edgeKey(citation.ref));
const labelOf = (citation: Citation): string => (citation.kind === 'entity' ? citation.title : `${citation.title} · ${citation.type}`);

function entriesOf(stage: NotesStage): AiNotesResponse | undefined {
  return stage.kind === 'ready' || stage.kind === 'loading' || stage.kind === 'failed' ? stage.entries : undefined;
}

/** The AI notes saved with the view, rebuilt by the server for the person; the section holds no count and writes no coverage line. */
export function NotesSection({ copies, sourceId, request }: { readonly copies: number; readonly sourceId: string; readonly request: number }) {
  const model = useNotes(copies, request);
  const heading = useRef<HTMLElement>(null);
  const asked = useRef(0);
  useEffect(() => {
    if (request === 0 || asked.current === request) return;
    asked.current = request;
    heading.current?.focus();
  }, [request]);
  const state = useClientState();
  const graph = useVisibleGraph();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const drawn = drawnKeys(graph);
  const held = new Set([...investigation.nodeRefs.map(elementKey), ...investigation.edgeRefs.map(edgeKey)]);
  const entries = entriesOf(model.stage);
  const press = (citation: Citation): void => {
    if (drawn.has(keyOf(citation))) state.presentation.select([keyOf(citation)]);
  };
  return (
    <details className="summary-notes" open={model.open} onToggle={(event) => (event.currentTarget.open === model.open ? undefined : model.toggle(event.currentTarget.open))}>
      <summary ref={heading}>{SUMMARY_COPY.notesTitle}</summary>
      <p className="summary-note">{SUMMARY_COPY.notesRebuilt}</p>
      {model.stage.kind === 'loading' && entries === undefined ? <p className="summary-note">{SUMMARY_COPY.notesLoading}</p> : null}
      {model.stage.kind === 'refused' ? <p className="summary-note">{SUMMARY_COPY.notesRefused}</p> : null}
      {model.stage.kind === 'failed' ? (
        <p className="summary-note" role="status">
          {SUMMARY_COPY.notesFailed} {failureWords(model.stage.failure, sourceId).text}{' '}
          {offersRetry(model.stage.failure) ? (
            <button type="button" className="summary-link" onClick={model.reload}>
              {SUMMARY_COPY.tryAgain}
            </button>
          ) : null}
        </p>
      ) : null}
      {entries !== undefined && entries.entries.length === 0 && entries.skipped.length === 0 && model.stage.kind !== 'loading' ? <p className="summary-note">{SUMMARY_COPY.notesNone}</p> : null}
      {entries?.skipped.length ? <p className="summary-note">{SUMMARY_COPY.notesSkipped}</p> : null}
      {entries?.entries.map((entry) => (
        <section key={entry.tokenId} className="summary-note-entry" aria-label={`${SUMMARY_COPY.drafted}, ${utcDateTime(entry.generatedAt)}`}>
          <div className="summary-tags">
            <span className="summary-tag summary-tag-accent">{entry.label}</span>
            <span className="summary-tag">{entry.model}</span>
            <span className="summary-tag">{utcDateTime(entry.generatedAt)}</span>
          </div>
          <ul className="summary-sentences">
            {entry.sentences.map((sentence, index) => (
              <li key={index} className="summary-block">
                <p>{sentence.text}</p>
                <span className="summary-chips">
                  {sentence.citations.map((citation, at) => (
                    <button key={at} type="button" className="summary-chip" aria-label={`${labelOf(citation)}, ${drawn.has(keyOf(citation)) ? SUMMARY_COPY.select : held.has(keyOf(citation)) ? SUMMARY_COPY.outsideView : SUMMARY_COPY.gone}`} onClick={() => press(citation)}>
                      {labelOf(citation)}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="summary-coverage">{entry.coverage}</p>
        </section>
      ))}
    </details>
  );
}
