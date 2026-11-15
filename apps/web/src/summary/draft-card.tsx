import { elementKey, edgeKey } from '../state/keys.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { callsText, removedText, SUMMARY_COPY } from './copy.js';
import type { CitationEntry } from './summary-model.js';
import type { SummaryDraft } from './summary-session.js';

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

interface DraftCardProps {
  readonly draft: SummaryDraft;
  readonly previous: boolean;
  readonly busy: boolean;
  readonly note: string;
  readonly onEdit: (index: number, text: string) => void;
  readonly onPress: (entry: CitationEntry) => void;
  readonly onRegenerate: () => void;
  readonly onDiscard: () => void;
}

export function DraftCard({ draft, previous, busy, note, onEdit, onPress, onRegenerate, onDiscard }: DraftCardProps) {
  const graph = useVisibleGraph();
  const state = useClientState();
  const investigation = useStoreSelector(state.investigation, (held) => held);
  const heldKeys = new Set([...investigation.nodeRefs.map(elementKey), ...investigation.edgeRefs.map(edgeKey)]);
  const drawn = drawnKeys(graph);
  const { response, entries } = draft;
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const edited = [...draft.edits].some(([index, text]) => text !== response.sentences[index]?.text);
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
          <li key={index} className="summary-block">
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
          </li>
        ))}
      </ol>
      <p className="summary-note" role="status">
        {note}
      </p>
      <CoverageBox retrieval={response.coverage.retrieval} summary={response.coverage.summary} />
      <div className="summary-actions">
        <button type="button" className="summary-button summary-button-outline" disabled={busy} onClick={onRegenerate}>
          {SUMMARY_COPY.regenerate}
        </button>
        <button type="button" className="summary-link" onClick={onDiscard}>
          {SUMMARY_COPY.discard}
        </button>
      </div>
      <p className="summary-tags">
        <span className="summary-tag">{SUMMARY_COPY.notSaved}</span>
      </p>
      <Disclosure sent={response.sent} calls={response.calls} />
    </section>
  );
}
