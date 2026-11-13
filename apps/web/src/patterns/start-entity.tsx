import { useEffect, useState } from 'react';
import type { GraphNode } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';
import { elementKey } from '../state/keys.js';
import { PATTERNS_COPY } from './copy.js';

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
}

type Found = { readonly kind: 'none' } | { readonly kind: 'found'; readonly nodes: readonly GraphNode[] } | { readonly kind: 'failed' };

/**
 * The starting entity is chosen, never typed as an identifier: from the selected and loaded entities of its type, or from a search of the source narrowed to that type. Typed text only ever reaches the search route.
 */
export function StartEntityField({ client, sourceId, mask, label, entityType, candidates, chosenKey, onChoose, selectRef, id = 'patterns-start' }: Props) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Found>({ kind: 'none' });
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === '') {
      setFound({ kind: 'none' });
      setAsked(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const send = async (): Promise<void> => {
        let result: Awaited<ReturnType<ApiClient['searchEntities']>>;
        try {
          result = await client.searchEntities({ sourceId, text: trimmed, entityTypes: [entityType], ...(mask ? { mask: true } : {}) }, controller.signal);
        } catch {
          result = UNEXPECTED;
        }
        if (controller.signal.aborted) return;
        setAsked(true);
        setFound(result.ok ? { kind: 'found', nodes: result.value.exact } : result.failure.code === 'ABORTED' ? { kind: 'none' } : { kind: 'failed' });
      };
      void send();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, client, sourceId, mask, entityType]);

  const listed = new Set(candidates.map((node) => elementKey(node.ref)));
  const extra = found.kind === 'found' ? found.nodes.filter((node) => !listed.has(elementKey(node.ref))) : [];
  const options = [...candidates, ...extra];
  return (
    <div className="patterns-field">
      <label className="supernode-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        ref={selectRef}
        className="patterns-input"
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
      <input type="search" className="patterns-input" aria-label={PATTERNS_COPY.searchLabel} placeholder={PATTERNS_COPY.searchLabel} autoComplete="off" value={text} onChange={(event) => setText(event.target.value)} />
      {found.kind === 'failed' ? (
        <p className="patterns-error" role="alert">
          {PATTERNS_COPY.searchFailed}
        </p>
      ) : asked && found.kind === 'found' && found.nodes.length === 0 ? (
        <p className="search-panel-note" role="status">
          {PATTERNS_COPY.searchNone}
        </p>
      ) : null}
    </div>
  );
}
