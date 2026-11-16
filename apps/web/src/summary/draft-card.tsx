import { elementKey, edgeKey } from '../state/keys.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { failureWords } from '../patterns/failure-words.js';
import { callsText, copiedText, noneStoredText, notCopiedText, notStoredReasons, removedText, SUMMARY_COPY } from './copy.js';
import { editedOf, storableCountOf, type CitationEntry, type DraftResponse } from './summary-model.js';
import type { CopyStage, SummaryDraft } from './summary-session.js';

const labelOf = (entry: CitationEntry): string => entry.label ?? `${entry.kind === 'entity' ? SUMMARY_COPY.entity : SUMMARY_COPY.relationship} ${entry.key}`;

export function Disclosure({ sent, calls }: { readonly sent: string; readonly calls: number }) {
  return (
    <details className="summary-disclosure">
      <summary>{SUMMARY_COPY.disclosure}</summary>
      <p className="summary-note">
        {SUMMARY_COPY.disclosureNote} {callsText(calls)}.
      </p>
      <pre className="summary-sent" tabIndex={0} aria-label={`${SUMMARY_COPY.disclosure}: ${SUMMARY_COPY.firstCallText}`}>
        {sent}
      </pre>
    </details>
  );
}

export function CoverageBox({ retrieval, summary }: { readonly retrieval: string; readonly summary: string }) {
  return (
    <div className="summary-coverage">
      <h4>{SUMMARY_COPY.coverageTitle}</h4>
      <p>
        {retrieval} · {summary}
      </p>
    </div>
  );
}

function copyWords(copy: CopyStage, sentences: DraftResponse['sentences'], sourceId: string): string {
  const total = sentences.length;
  switch (copy.kind) {
    case 'idle':
    case 'copying':
      return '';
    case 'copied':
      return copy.alreadyCopied ? SUMMARY_COPY.alreadyCopied : copy.notCopied === 0 ? copiedText(copy.copied) : `${copiedText(copy.copied)} ${notCopiedText(copy.notCopied, total, notStoredReasons(sentences))}`;
    case 'refused':
      return SUMMARY_COPY.generateAgain;
    case 'full':
      return SUMMARY_COPY.notesFull;
    case 'conflict':
      return SUMMARY_COPY.copyConflict;
    case 'failed':
      return copy.failure === undefined ? SUMMARY_COPY.copyFailed : failureWords(copy.failure, sourceId).text;
  }
}

interface DraftCardProps {
  readonly draft: SummaryDraft;
  readonly previous: boolean;
  readonly busy: boolean;
  readonly note: string;
  readonly copy: CopyStage;
  readonly sourceId: string;
  readonly onCopy: () => void;
  readonly onEdit: (index: number, text: string) => void;
  readonly onPress: (entry: CitationEntry) => void;
  readonly onRegenerate: () => void;
  readonly onDiscard: () => void;
}

export function DraftCard({ draft, previous, busy, note, copy, sourceId, onCopy, onEdit, onPress, onRegenerate, onDiscard }: DraftCardProps) {
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const heldKeys = new Set([...investigation.nodeRefs.map(elementKey), ...investigation.edgeRefs.map(edgeKey)]);
  const drawn = drawnKeys(graph);
  const { response, entries } = draft;
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const edited = editedOf(draft);
  const storable = storableCountOf(response);
  const skipped = copy.kind === 'copied' && copy.notCopied > 0;
  const canCopy = !edited && storable > 0 && !busy && copy.kind !== 'copying';
  const statusWords = (entry: CitationEntry): string => (drawn.has(entry.graphKey) ? SUMMARY_COPY.select : heldKeys.has(entry.graphKey) ? SUMMARY_COPY.outsideView : SUMMARY_COPY.gone);
  return (
    <section className="summary-draft" aria-labelledby="summary-draft-title">
      <h3 id="summary-draft-title" className="visually-hidden" tabIndex={-1} data-summary-focus="draft">
        {SUMMARY_COPY.sentences}
      </h3>
      <div className="summary-tags">
        <span className="summary-tag summary-tag-accent">{SUMMARY_COPY.drafted}</span>
        <span className="summary-tag">{response.model}</span>
        {previous ? <span className="summary-tag">{SUMMARY_COPY.previous}</span> : null}
        {edited ? <span className="summary-tag">{SUMMARY_COPY.edited}</span> : null}
      </div>
      <p className="summary-view">{draft.viewLine}</p>
      {response.status === 'partial' ? <p className="summary-note">{removedText(response.removedCount)}</p> : null}
      <ol className="summary-sentences">
        {response.sentences.map((sentence, index) => (
          <li key={index} className={skipped && !sentence.storable ? 'summary-block summary-block-skipped' : 'summary-block'}>
            <textarea
              className="summary-sentence"
              aria-label={`${SUMMARY_COPY.sentence} ${index + 1}`}
              rows={2}
              value={draft.edits.get(index) ?? sentence.text}
              onChange={(event) => onEdit(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                event.currentTarget.closest('.summary-draft')?.querySelector<HTMLElement>('[data-summary-focus="draft"]')?.focus();
              }}
            />
            <span className="summary-chips">
              {sentence.cites.map((key) => {
                const entry = byKey.get(key);
                return entry === undefined ? null : (
                  <button key={key} type="button" className="summary-chip" aria-label={`Citation ${entry.number}, ${labelOf(entry)}, ${statusWords(entry).toLowerCase()}`} onClick={() => onPress(entry)}>
                    <span aria-hidden="true">[{entry.number}]</span> {labelOf(entry)}
                    {drawn.has(entry.graphKey) ? null : <span className="summary-chip-note">{heldKeys.has(entry.graphKey) ? SUMMARY_COPY.outsideView : SUMMARY_COPY.gone}</span>}
                  </button>
                );
              })}
            </span>
            {sentence.storable ? null : <span className="summary-tag summary-tag-skipped">{SUMMARY_COPY.notCopied}</span>}
          </li>
        ))}
      </ol>
      <p className="summary-note" role="status">
        {note}
      </p>
      <CoverageBox retrieval={response.coverage.retrieval} summary={response.coverage.summary} />
      <div className="summary-actions">
        <button type="button" className="summary-button" disabled={!canCopy} onClick={onCopy}>
          {copy.kind === 'copying' ? SUMMARY_COPY.copying : SUMMARY_COPY.copyToNotes}
        </button>
        <button type="button" className="summary-button summary-button-outline" disabled={busy} onClick={onRegenerate}>
          {SUMMARY_COPY.regenerate}
        </button>
        <button type="button" className="summary-link" onClick={onDiscard}>
          {SUMMARY_COPY.discard}
        </button>
      </div>
      <p className="summary-note" role="status">
        {edited ? SUMMARY_COPY.editedNoCopy : storable === 0 ? noneStoredText(notStoredReasons(response.sentences)) : copyWords(copy, response.sentences, sourceId)}
      </p>
      {copy.kind === 'conflict' || (copy.kind === 'failed' && (copy.failure === undefined || failureWords(copy.failure, sourceId).action === 'try-again')) ? (
        <button type="button" className="summary-link" onClick={onCopy}>
          {SUMMARY_COPY.tryAgain}
        </button>
      ) : null}
      <p className="summary-tags">
        <span className="summary-tag">{SUMMARY_COPY.notSaved}</span>
      </p>
      <Disclosure sent={response.sent} calls={response.calls} />
    </section>
  );
}
