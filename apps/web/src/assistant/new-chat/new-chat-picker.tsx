import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import type { InvestigationListItem } from '@neburyx/contracts';
import { useApiClient } from '../../api/client-context.js';
import { offersRetry } from '../../failure-notice.js';
import { READ_WAIT_MS } from '../read-wait.js';
import { ListFailure } from '../list-failure.js';
import { useInvestigationList } from '../../investigations-page/use-investigation-list.js';
import { SEARCH_DEBOUNCE_MS } from '../../patterns/start-entity.js';
import { ASSISTANT_PATH } from '../../shell/navigation.js';
import { REMOVED_CHIP, REPOINTED_CHIP } from '../../lifecycle/copy.js';
import { matchingText, NEW_CHAT_COPY, rowDetailOf } from './copy.js';
import { useChatsOf, type ChatKnowledge } from './use-chats-of.js';

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
  readonly maxHeight: number;
}

/** A length of the picker's tokens, in pixels. */
function tokenPx(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Where the card goes: under the button with the gap of the frame, as tall as the window leaves it. In a window too short for a card of the least height under the button (a short window, or a page at 200% zoom) the card goes up over the button instead, so that it
 * stays inside the window with its heading, its search and its footer in view, and only its list of rows scrolls.
 */
function placeOf(box: DOMRect): Place {
  const gap = tokenPx('--new-chat-gap', 12);
  const gutter = tokenPx('--new-chat-gutter', 16);
  const least = tokenPx('--new-chat-least-height', 300);
  const below = window.innerHeight - box.bottom - gap - gutter;
  const top = below >= least ? box.bottom + gap : Math.max(gutter, window.innerHeight - gutter - least);
  // the card is as wide as the token says, or as the window leaves it, and never runs past the right gutter
  const width = Math.min(tokenPx('--new-chat-width', 400), window.innerWidth - 2 * gutter);
  return { left: Math.max(gutter, Math.min(box.left, window.innerWidth - gutter - width)), top, maxHeight: Math.max(0, window.innerHeight - top - gutter) };
}

/** The chip that says a source is gone, for a state that is not `available`. */
const goneChipOf = (row: InvestigationListItem): string | undefined => (row.sourceState === 'removed' ? REMOVED_CHIP : row.sourceState === 'repointed' ? REPOINTED_CHIP : undefined);

/**
 * Whether a row can be picked: one whose source is available always; one whose source is gone only when it has a chat, which the page then shows as it shows an investigation whose source has changed. While the lookup has not answered, or failed, a row whose source is gone is
 * not pickable and claims nothing.
 */
const pickable = (row: InvestigationListItem, chat: ChatKnowledge): boolean => goneChipOf(row) === undefined || chat === 'yes';

function PickerRow({ row, chat, optionId, active, onPick }: { readonly row: InvestigationListItem; readonly chat: ChatKnowledge; readonly optionId: string; readonly active: boolean; readonly onPick: () => void }) {
  const chip = goneChipOf(row);
  const enabled = pickable(row, chat);
  const reason = useId();
  return (
    <li
      id={optionId}
      role="option"
      aria-selected={active}
      aria-disabled={enabled ? undefined : true}
      aria-describedby={enabled || chip === undefined ? undefined : reason}
      className={`new-chat-row${enabled ? '' : ' new-chat-row-gone'}${active ? ' new-chat-row-active' : ''}`}
      onClick={onPick}
    >
      <span className="new-chat-row-text">
        <span className="new-chat-row-title">{row.title}</span>
        <span className="new-chat-row-detail">{rowDetailOf(row.caseRef, row.sourceAlias)}</span>
      </span>
      <span className="new-chat-row-marks">
        {chat === 'yes' ? <span className="new-chat-chip">{NEW_CHAT_COPY.hasChat}</span> : null}
        {chip === undefined ? null : (
          <span id={reason} className="new-chat-chip new-chat-chip-gone">
            {chip}
          </span>
        )}
        {chat === 'no' && chip === undefined ? (
          <span className="new-chat-start" aria-hidden="true">
            {NEW_CHAT_COPY.startChat}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** The picker of a new chat (frame 5b-1): the person's open investigations, and a pick opens the chat of the one chosen. */
export function NewChatPicker({ anchor, onClose }: NewChatPickerProps) {
  const client = useApiClient();
  const navigate = useNavigate();
  const titleId = useId();
  const listId = useId();
  const [active, setActive] = useState<string | undefined>(undefined);
  const card = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const [place, setPlace] = useState<Place | undefined>(undefined);
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const list = useInvestigationList(client, { status: 'open', sourceId: undefined, text: query, limit: PAGE_SIZE }, { readWaitMs: READ_WAIT_MS });
  const { state } = list;
  // while a search is read the rows of the earlier list are not drawn, so they cannot be highlighted or picked either
  const waiting = state.items === undefined || state.loading;
  // a failed read of the list takes the earlier rows off the screen too: they cannot be highlighted, picked, asked about or followed by Show more
  const shown = !waiting && state.failure?.where !== 'first';
  const rows = !shown ? [] : (state.items ?? []).filter((row) => row.status === 'open');
  const { chatOf, failed: lookupFailed, retry: retryLookup } = useChatsOf(rows.map((row) => row.id));
  const optionOf = (id: string): string => `${listId}-${id}`;
  /** The rows the highlight can stop on: those that can be picked. */
  const stops = rows.filter((row) => pickable(row, chatOf(row.id)));
  const stopIds = stops.map((row) => row.id).join(',');
  // a search changes the list: the highlight goes to no row, and so does one whose row is no longer drawn
  useEffect(() => setActive(undefined), [query]);
  useEffect(() => {
    if (active !== undefined && !stopIds.split(',').includes(active)) setActive(undefined);
  }, [active, stopIds]);
  useEffect(() => {
    if (active !== undefined) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);

  useLayoutEffect(() => {
    const place_ = (): void => {
      const box = anchor.current?.getBoundingClientRect();
      if (box !== undefined) setPlace(placeOf(box));
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

  // a control that has the focus and goes (the last Show more, a retry that worked) leaves the focus in the search box, not on the page
  useEffect(() => {
    if (card.current !== null && document.activeElement === document.body) search.current?.focus();
  }, [state.nextCursor, state.failure, state.loading, lookupFailed]);

  const placed = place !== undefined;
  useEffect(() => {
    if (placed) search.current?.focus();
  }, [placed]);

  useEffect(() => {
    // Escape closes the picker wherever the focus is, and goes no further
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [anchor, onClose]);

  useEffect(() => {
    // a press outside the picker and the button that opened it closes it; the button's own press is the opener's to answer
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || card.current?.contains(target) === true || anchor.current?.contains(target) === true) return;
      onClose();
      // the focus goes back to the button unless the press landed on something that takes it: the press itself moves the focus to the page after this, so it is given back once that has happened
      window.setTimeout(() => {
        if (document.activeElement === document.body || document.activeElement === null) anchor.current?.focus();
      }, 0);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, onClose]);

  const pick = (row: InvestigationListItem): void => {
    if (!pickable(row, chatOf(row.id))) return;
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
      style={{ left: place.left, top: place.top, maxHeight: place.maxHeight }}
      onMouseDown={(event) => {
        // a press on the text or a row of the picker leaves the focus where it is, so that the keys still reach it
        if (!(event.target instanceof Element) || event.target.closest('input, button') === null) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || card.current === null) return;
        // the focus stays inside the picker until it closes
        const inside = [...card.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
        const first = inside[0];
        const last = inside.at(-1);
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="new-chat-heading">
        <h2 id={titleId}>{NEW_CHAT_COPY.title}</h2>
        <p>{NEW_CHAT_COPY.description}</p>
      </div>
      <div className="new-chat-search">
        <label className="new-chat-search-box">
          <span className="icon icon-find" aria-hidden="true" />
          <input
            ref={search}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={waiting || rows.length === 0 ? undefined : listId}
            aria-activedescendant={active === undefined ? undefined : optionOf(active)}
            value={text}
            placeholder={NEW_CHAT_COPY.searchLabel}
            aria-label={NEW_CHAT_COPY.searchLabel}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              const at = stops.findIndex((row) => row.id === active);
              const to = (index: number): void => {
                const row = stops[index];
                if (row === undefined) return;
                event.preventDefault();
                setActive(row.id);
              };
              if (event.key === 'ArrowDown' && stops.length > 0) to(at < 0 || at === stops.length - 1 ? 0 : at + 1);
              else if (event.key === 'ArrowUp' && stops.length > 0) to(at <= 0 ? stops.length - 1 : at - 1);
              // Home and End move the highlight once there is one; with none they keep their place in the text
              else if (event.key === 'Home' && at >= 0) to(0);
              else if (event.key === 'End' && at >= 0) to(stops.length - 1);
              else if (event.key === 'Enter' && at >= 0) {
                event.preventDefault();
                const row = stops[at];
                if (row !== undefined) pick(row);
              }
            }}
          />
        </label>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {state.items === undefined || state.loading || state.matching === undefined ? '' : matchingText(state.matching, query !== undefined)}
      </p>
      <div className="new-chat-rows">
        {state.failure?.where === 'first' ? (
          <div className="new-chat-note">
            <ListFailure failure={state.failure.failure} />
            {offersRetry(state.failure.failure) ? (
              <button type="button" className="secondary" onClick={list.retry}>
                {NEW_CHAT_COPY.tryAgain}
              </button>
            ) : null}
          </div>
        ) : state.items === undefined || state.loading ? (
          <p className="new-chat-note">{NEW_CHAT_COPY.loading}</p>
        ) : rows.length === 0 && state.nextCursor === null ? (
          <p className="new-chat-note">{query === undefined ? NEW_CHAT_COPY.empty : NEW_CHAT_COPY.noMatch}</p>
        ) : (
          <ul id={listId} role="listbox" aria-label={NEW_CHAT_COPY.listLabel} className="new-chat-list">
            {rows.map((row) => (
              <PickerRow key={row.id} row={row} chat={chatOf(row.id)} optionId={optionOf(row.id)} active={row.id === active} onPick={() => pick(row)} />
            ))}
          </ul>
        )}
        {shown && state.nextCursor !== null ? (
          <div className="new-chat-more">
            {state.failure?.where === 'more' ? <p className="new-chat-note" role="alert">{NEW_CHAT_COPY.moreFailed}</p> : null}
            <button type="button" className="new-chat-more-button" disabled={state.loadingMore} onClick={list.showMore}>
              {state.loadingMore ? NEW_CHAT_COPY.loadingMore : NEW_CHAT_COPY.showMore}
            </button>
          </div>
        ) : null}
      </div>
      {lookupFailed && shown ? (
        <div className="new-chat-note">
          <p role="alert">{NEW_CHAT_COPY.lookupFailed}</p>
          <button type="button" className="secondary" aria-label={NEW_CHAT_COPY.lookupTryAgain} onClick={retryLookup}>
            {NEW_CHAT_COPY.tryAgain}
          </button>
        </div>
      ) : null}
      <p className="new-chat-footer">{NEW_CHAT_COPY.footer}</p>
    </div>,
    document.body,
  );
}
