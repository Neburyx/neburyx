import { useEffect, useState } from 'react';
import type { Count, GraphNode } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { boundedRead, SEARCH_WAIT_MS } from '../api/read-wait.js';
import { UNEXPECTED } from '../api/use-request.js';
import { RetryButton } from '../failure-box.js';
import { RETRY_NAMES } from '../failure-copy.js';
import { offersRetry } from '../failure-notice.js';
import { elementKey } from '../state/keys.js';
import { PATTERNS_COPY } from './copy.js';
import { SEARCHING } from '../waiting-copy.js';
import { WaitingLine } from '../waiting.js';

export const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly label: string;
  /** The entity type the pattern starts from; the search is narrowed to it. */
  readonly entityType: string;
  /** The selected entities of that type first, then the other loaded ones. */
  readonly candidates: readonly GraphNode[];
  readonly chosenKey: string | undefined;
  readonly onChoose: (node: GraphNode) => void;
  readonly selectRef: React.Ref<HTMLSelectElement>;
  /** The id of the select, so that two fields in one panel (the preset form and the builder's run) each have their label. */
  readonly id?: string;
  /** The search of the source is behind a link until it is asked for, so that the field reads as the select of the design. */
  readonly collapsedSearch?: boolean;
}

type Found =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly nodes: readonly GraphNode[]; readonly count: Count | undefined }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export interface EntitySearch {
  readonly found: Found;
  /** What the last answered search of this source, type and masking found: it stays listed when a later search fails. */
  readonly earlier: readonly GraphNode[];
  /** A search for the text typed is out and has no answer yet. */
  readonly waiting: boolean;
  /** Searches again for the text typed. */
  readonly retry: () => void;
  /** Whether an answer to the text typed has arrived. */
  readonly asked: boolean;
}

/** The search of the source for the text typed, narrowed to one entity type when one is given and over every type when not, after a pause; typed text only ever reaches the search route. An answer to older text is never shown. */
export function useEntitySearch(client: ApiClient, sourceId: string, mask: boolean, entityType: string | undefined, text: string): EntitySearch {
  const [found, setFound] = useState<Found>({ kind: 'none' });
  const [asked, setAsked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const scope = JSON.stringify([sourceId, mask, entityType]);
  const [answered, setAnswered] = useState<{ readonly scope: string; readonly nodes: readonly GraphNode[] }>({ scope, nodes: [] });

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === '') {
      setFound({ kind: 'none' });
      setAsked(false);
      setWaiting(false);
      return undefined;
    }
    const controller = new AbortController();
    setWaiting(true);
    const timer = setTimeout(() => {
      const send = async (): Promise<void> => {
        let result: Awaited<ReturnType<ApiClient['searchEntities']>>;
        try {
          result = await boundedRead((signal) => client.searchEntities({ sourceId, text: trimmed, ...(entityType === undefined ? {} : { entityTypes: [entityType] }), ...(mask ? { mask: true } : {}) }, signal), controller.signal, SEARCH_WAIT_MS);
        } catch {
          result = UNEXPECTED;
        }
        if (controller.signal.aborted) return;
        setWaiting(false);
        setAsked(true);
        if (result.ok) setAnswered({ scope, nodes: result.value.exact });
        setFound(result.ok ? { kind: 'found', nodes: result.value.exact, count: result.value.counts.exact } : result.failure.code === 'ABORTED' ? { kind: 'none' } : { kind: 'failed', failure: result.failure });
      };
      void send();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, client, sourceId, mask, entityType, scope, attempt]);

  const retry = (): void => setAttempt((count) => count + 1);
  return { found, asked, waiting, earlier: text.trim() === '' || answered.scope !== scope ? [] : answered.nodes, retry };
}

/** The line of a picker's failed search, with Try again beside it where a retry helps. */
export function SearchFailed({ text, failure, retry }: { readonly text: string; readonly failure: ApiFailure; readonly retry: () => void }) {
  return (
    <div className="search-failed">
      <p className="patterns-error" role="alert">
        {text}
      </p>
      {offersRetry(failure) ? <RetryButton name={RETRY_NAMES.sourceSearch} run={retry} /> : null}
    </div>
  );
}

/**
 * The starting entity is chosen, never typed as an identifier: from the selected and loaded entities of its type, or from a search of the source narrowed to that type. Typed text only ever reaches the search route.
 */
export function StartEntityField({ client, sourceId, mask, label, entityType, candidates, chosenKey, onChoose, selectRef, id = 'patterns-start', collapsedSearch = false }: Props) {
  const [text, setText] = useState('');
  const [searching, setSearching] = useState(false);
  const { found, asked, waiting, earlier, retry } = useEntitySearch(client, sourceId, mask, entityType, text);

  const listed = new Set(candidates.map((node) => elementKey(node.ref)));
  const searched = found.kind === 'found' ? found.nodes : found.kind === 'failed' ? earlier : [];
  const extra = searched.filter((node) => !listed.has(elementKey(node.ref)));
  const options = [...candidates, ...extra];
  return (
    <div className="patterns-field" aria-busy={waiting ? true : undefined}>
      <label className="supernode-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        ref={selectRef}
        className="select-control"
        value={chosenKey ?? ''}
        onChange={(event) => {
          const node = options.find((candidate) => elementKey(candidate.ref) === event.target.value);
          if (node !== undefined) onChoose(node);
        }}
      >
        <option value="" disabled>
          {PATTERNS_COPY.startNone}
        </option>
        {options.map((node) => (
          <option key={elementKey(node.ref)} value={elementKey(node.ref)}>
            {node.display.title}
          </option>
        ))}
      </select>
      {collapsedSearch && !searching && text === '' ? (
        <button type="button" className="link" onClick={() => setSearching(true)}>
          {PATTERNS_COPY.searchLabel}
        </button>
      ) : (
        <input type="search" className="patterns-input" aria-label={PATTERNS_COPY.searchLabel} placeholder={PATTERNS_COPY.searchLabel} autoComplete="off" autoFocus={collapsedSearch && searching} value={text} onChange={(event) => setText(event.target.value)} />
      )}
      {waiting ? (
        <WaitingLine word={SEARCHING} />
      ) : found.kind === 'failed' ? (
        <SearchFailed text={PATTERNS_COPY.searchFailed} failure={found.failure} retry={retry} />
      ) : asked && found.kind === 'found' && found.nodes.length === 0 ? (
        <p className="search-panel-note" role="status">
          {PATTERNS_COPY.searchNone}
        </p>
      ) : null}
    </div>
  );
}
