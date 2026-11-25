import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import type { InvestigationListItem } from '@neburyx/contracts';
import { useApiClient } from '../../api/client-context.js';
import { canRetry, FailureNotice } from '../../failure-notice.js';
import { useInvestigationList } from '../../investigations-page/use-investigation-list.js';
import { SEARCH_DEBOUNCE_MS } from '../../patterns/start-entity.js';
import { ASSISTANT_PATH } from '../../shell/navigation.js';
import { NEW_CHAT_COPY, rowDetailOf } from './copy.js';

/** The rows a page of the list holds. */
const PAGE_SIZE = 25;

/** The shortest search text the server accepts. */
const MIN_SEARCH_CHARACTERS = 2;

export interface NewChatPickerProps {
  /** The button that opened the picker: it is what the picker sits under, what a press on it is not "outside" of, and where the focus goes back to. */
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

interface Place {
  readonly left: number;
  readonly top: number;
}

/** The picker of a new chat (frame 5b-1): the person's open investigations, and a pick opens the chat of the one chosen. */
export function NewChatPicker({ anchor, onClose }: NewChatPickerProps) {
  const client = useApiClient();
  const navigate = useNavigate();
  const titleId = useId();
  const card = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const [place, setPlace] = useState<Place | undefined>(undefined);
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const list = useInvestigationList(client, { status: 'open', sourceId: undefined, text: query, limit: PAGE_SIZE });
  const { state } = list;
  const rows = (state.items ?? []).filter((row) => row.status === 'open');

  useLayoutEffect(() => {
    const place_ = (): void => {
      const box = anchor.current?.getBoundingClientRect();
      if (box !== undefined) setPlace({ left: box.left, top: box.bottom });
    };
    place_();
    window.addEventListener('resize', place_);
    return () => window.removeEventListener('resize', place_);
  }, [anchor]);

  useEffect(() => {
    const trimmed = text.trim();
    const next = [...trimmed].length >= MIN_SEARCH_CHARACTERS ? trimmed : undefined;
    if (next === query) return;
    const timer = window.setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, query]);

  const close = (): void => {
    onClose();
    anchor.current?.focus();
  };

  const placed = place !== undefined;
  useEffect(() => {
    if (placed) search.current?.focus();
  }, [placed]);

  useEffect(() => {
    // a press outside the picker and the button that opened it closes it; the button's own press is the opener's to answer
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || card.current?.contains(target) === true || anchor.current?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, onClose]);

  const pick = (row: InvestigationListItem): void => {
    close();
    void navigate(`${ASSISTANT_PATH}/${encodeURIComponent(row.id)}`);
  };

  if (place === undefined || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="new-chat"
      style={{ left: place.left, top: place.top }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        close();
      }}
    >
      <div className="new-chat-heading">
        <h2 id={titleId}>{NEW_CHAT_COPY.title}</h2>
        <p>{NEW_CHAT_COPY.description}</p>
      </div>
      <div className="new-chat-search">
        <label className="new-chat-search-box">
          <span className="icon icon-find" aria-hidden="true" />
          <input ref={search} type="search" value={text} placeholder={NEW_CHAT_COPY.searchLabel} aria-label={NEW_CHAT_COPY.searchLabel} onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
      <div className="new-chat-rows">
        {state.failure?.where === 'first' ? (
          <div className="new-chat-note">
            <FailureNotice failure={state.failure.failure} />
            {canRetry(state.failure.failure) ? (
              <button type="button" className="secondary" onClick={list.retry}>
                {NEW_CHAT_COPY.tryAgain}
              </button>
            ) : null}
          </div>
        ) : state.items === undefined || state.loading ? (
          <p className="new-chat-note" role="status">{NEW_CHAT_COPY.loading}</p>
        ) : rows.length === 0 && state.nextCursor === null ? (
          <p className="new-chat-note">{query === undefined ? NEW_CHAT_COPY.empty : NEW_CHAT_COPY.noMatch}</p>
        ) : (
          <ul role="listbox" aria-label={NEW_CHAT_COPY.listLabel} className="new-chat-list">
            {rows.map((row) => (
              <li key={row.id} role="option" aria-selected={false} className="new-chat-row" onClick={() => pick(row)}>
                <span className="new-chat-row-text">
                  <span className="new-chat-row-title">{row.title}</span>
                  <span className="new-chat-row-detail">{rowDetailOf(row.caseRef, row.sourceAlias)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.items !== undefined && !state.loading && state.nextCursor !== null ? (
          <div className="new-chat-more">
            {state.failure?.where === 'more' ? <p className="new-chat-note" role="alert">{NEW_CHAT_COPY.moreFailed}</p> : null}
            <button type="button" className="new-chat-more-button" disabled={state.loadingMore} onClick={list.showMore}>
              {state.loadingMore ? NEW_CHAT_COPY.loadingMore : NEW_CHAT_COPY.showMore}
            </button>
          </div>
        ) : null}
      </div>
      <p className="new-chat-footer">{NEW_CHAT_COPY.footer}</p>
    </div>,
    document.body,
  );
}
