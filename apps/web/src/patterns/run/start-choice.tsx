import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphNode } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { degreeCountText } from '../../workspace/degree-text.js';
import { elementKey } from '../../state/keys.js';
import { failureView, PATTERNS_COPY } from '../copy.js';
import { useEntitySearch } from '../start-entity.js';
import { entityLabel } from './entity-label.js';
import { RUN_COPY, searchSummary, startFrom, startHelper, typesMatching, typesOnCanvas } from './run-copy.js';

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly typeName: string;
  readonly entityType: string;
  /** The selected entities of the type first, then the other loaded ones. */
  readonly candidates: readonly GraphNode[];
  readonly chosen: GraphNode | undefined;
  readonly onChoose: (node: GraphNode) => void;
  /** Whether an entity's ID may be written beside its name: not while masking is on, because an ID can be a personal-data value. */
  readonly showIds: boolean;
  readonly inputId: string;
}

/**
 * "Start from: <Type>": the entity is chosen, never typed as an identifier. Loaded entities of the type are listed, the selected one first, and typed text searches the source narrowed to the type, through the search route; the list is chosen by arrows and Enter.
 */
export function StartChoice({ client, sourceId, sourceName, mask, typeName, entityType, candidates, chosen, onChoose, showIds, inputId }: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const { found, asked } = useEntitySearch(client, sourceId, mask, entityType, text);
  const typed = text.trim() !== '';
  const options: readonly GraphNode[] = typed ? (found.kind === 'found' ? found.nodes : []) : candidates;
  const listing = open && (typed ? asked || found.kind === 'failed' : candidates.length > 0);
  const choose = (node: GraphNode): void => {
    onChoose(node);
    setText('');
    setOpen(false);
    setActive(0);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (options.length > 0) setActive((index) => (event.key === 'ArrowDown' ? (index + 1) % options.length : (index - 1 + options.length) % options.length));
    } else if (event.key === 'Enter' && listing) {
      const node = options[active];
      if (node !== undefined) {
        event.preventDefault();
        choose(node);
      }
    }
  };
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const node = field.current;
    if (node === null || !listing) return undefined;
    // the panel's frame listens for Escape before React does: the list closes first, with a listener on the field itself, and the panel only when no list is open
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    node.addEventListener('keydown', onEscape);
    return () => node.removeEventListener('keydown', onEscape);
  }, [listing]);
  const total = found.kind === 'found' && found.count?.value !== undefined ? degreeCountText(found.count) : undefined;
  return (
    <div className="patterns-field run-start">
      <label className="supernode-label" htmlFor={inputId}>
        {startFrom(typeName)}
      </label>
      <input
        id={inputId}
        ref={field}
        type="search"
        role="combobox"
        className="patterns-input"
        placeholder={RUN_COPY.searchPlaceholder}
        autoComplete="off"
        aria-expanded={listing}
        {...(listing && !(found.kind === 'failed' && typed) ? { 'aria-controls': listId } : {})}
        aria-autocomplete="list"
        {...(chosen === undefined ? { 'aria-describedby': `${inputId}-help` } : {})}
        {...(listing && options[active] !== undefined ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {listing ? (
        <div className="run-start-list" onMouseDown={(event) => event.preventDefault()}>
          <p className="run-start-heading">{typed ? typesMatching(typeName, text.trim()) : typesOnCanvas(typeName)}</p>
          {found.kind === 'failed' && typed ? (
            <p className="patterns-error" role="alert">
              {failureView(found.failure, sourceName).text}
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label={typed ? typesMatching(typeName, text.trim()) : typesOnCanvas(typeName)}>
              {options.map((node, index) => {
                const label = entityLabel(node, showIds);
                return (
                  <li key={elementKey(node.ref)} id={`${listId}-${index}`} role="option" aria-selected={index === active} data-active={index === active ? 'true' : undefined} title={label.id === undefined ? label.title : `${label.title} · ${label.id}`} onClick={() => choose(node)}>
                    <span className={label.titleIsId ? 'run-start-id run-start-title' : 'run-start-title'}>{label.title}</span>
                    {label.id === undefined ? null : <span className="run-start-id">{label.id}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {typed && found.kind === 'found' ? (
            <p className="run-start-note" role="status">
              {options.length === 0 ? PATTERNS_COPY.searchNone : searchSummary(options.length, total)}
            </p>
          ) : null}
        </div>
      ) : null}
      {chosen === undefined ? null : <ChosenLine node={chosen} showIds={showIds} />}
      {chosen === undefined ? (
        <p className="search-panel-note" id={`${inputId}-help`}>
          {startHelper(typeName)}
        </p>
      ) : null}
    </div>
  );
}

function ChosenLine({ node, showIds }: { readonly node: GraphNode; readonly showIds: boolean }) {
  const label = entityLabel(node, showIds);
  return (
    <p className="run-start-chosen" role="status" title={label.id === undefined ? label.title : `${label.title} · ${label.id}`}>
      <span className="run-start-label">{RUN_COPY.chosen}: </span>
      <strong className={label.titleIsId ? 'run-start-id run-start-title' : 'run-start-title'}>{label.title}</strong>
      {label.id === undefined ? null : <span className="run-start-id">{label.id}</span>}
    </p>
  );
}
