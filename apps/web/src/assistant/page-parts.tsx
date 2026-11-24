import type { RefObject } from 'react';
import { Link } from 'react-router';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { useVisibleGraph, useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { answeredData, useAssistantModelWhenProvided, useShellDataWhenProvided } from '../shell/shell-data.js';
import { sourceNameOf } from '../shell/current-source.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { ASSISTANT_COPY } from './copy.js';
import { useSuggestions } from './suggestions.js';

/** What the canvas draws: each loaded entity and each relationship between two of them. Both are counted from what is drawn, so they are exact. */
function shownCounts(graph: LoadedGraph): { readonly entities: number; readonly relationships: number } {
  return { entities: graph.nodes.length, relationships: partitionEdges(graph).drawable.length };
}

export function PageHeader({ clearButton, hasThread, pending, onClear }: { readonly clearButton: RefObject<HTMLButtonElement | null>; readonly hasThread: boolean; readonly pending: boolean; readonly onClear: () => void }) {
  const state = useClientState();
  const held = useStoreSelector(state.investigation, (investigation) => investigation);
  const shell = useShellDataWhenProvided();
  const sources = shell === undefined ? [] : (answeredData(shell.sources)?.items ?? []);
  const record = held.record;
  const parts = [held.sourceId === null ? undefined : sourceNameOf(sources, held.sourceId), ASSISTANT_COPY.readOnly, record?.caseRef ?? undefined].filter((part) => part !== undefined && part !== '');
  return (
    <header className="assistant-page-head">
      <div className="assistant-page-head-text">
        <h1>{record?.title ?? ''}</h1>
        <p>{parts.join(' · ')}</p>
      </div>
      {held.id === null ? null : (
        <Link className="assistant-page-button" to={`${EXPLORE_PATH}/${held.id}`}>
          <span className="icon icon-arrow-up-right" aria-hidden="true" />
          {ASSISTANT_COPY.openGraph}
        </Link>
      )}
      <button ref={clearButton} type="button" className="assistant-page-button" disabled={pending || !hasThread} onClick={onClear}>
        {ASSISTANT_COPY.clearChat}
      </button>
    </header>
  );
}

function Sparkle() {
  return (
    <span className="assistant-empty-icon" aria-hidden="true">
      <span className="icon icon-assistant" />
    </span>
  );
}

export function EmptyThread({ send, busy, limit }: { readonly send: (text: string) => void; readonly busy: boolean; readonly limit: number | undefined }) {
  const state = useClientState();
  const title = useStoreSelector(state.investigation, (investigation) => investigation.record?.title ?? '');
  const graph = useVisibleGraph();
  const suggestions = useSuggestions(limit);
  const model = useAssistantModelWhenProvided();
  const counts = shownCounts(graph);
  return (
    <section className="assistant-empty" aria-labelledby="assistant-empty-title">
      <Sparkle />
      <h2 id="assistant-empty-title">{ASSISTANT_COPY.pageEmptyTitle(title)}</h2>
      <p>{ASSISTANT_COPY.pageEmptyBody}</p>
      <div className="assistant-empty-suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion.question} type="button" disabled={busy} onClick={() => send(suggestion.question)}>
            {suggestion.label}
          </button>
        ))}
      </div>
      <p className="assistant-empty-line">{ASSISTANT_COPY.modelLine(model, counts.entities, counts.relationships)}</p>
    </section>
  );
}
