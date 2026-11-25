import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { canRetry, FailureNotice } from '../../failure-notice.js';
import { REMOVED_CHIP, REPOINTED_CHIP } from '../../lifecycle/copy.js';
import { SEARCH_DEBOUNCE_MS } from '../../patterns/start-entity.js';
import { ASSISTANT_PATH } from '../../shell/navigation.js';
import { useClientState } from '../../state/context.js';
import { useStoreSelector } from '../../state/store.js';
import { useAssistantSession } from '../assistant-session.js';
import { groupChats } from './chat-groups.js';
import { CHAT_LIST_COPY } from './copy.js';
import { useChatList, type ChatRow } from './use-chat-list.js';

/** The window in which a second sign that the window was shown does not read the list again. */
const SHOWN_COALESCE_MS = 400;

/** The shortest search text the server accepts. */
const MIN_SEARCH_CHARACTERS = 2;

export interface ChatListColumnProps {
  /** The picker of a new chat opens from this; with none the button is drawn disabled. */
  readonly onNewChat?: (() => void) | undefined;
  /** The button of New chat, so that the picker can anchor to it and give focus back to it. */
  readonly newChatRef?: RefObject<HTMLButtonElement | null> | undefined;
  /** The clock, for a test. */
  readonly now?: (() => Date) | undefined;
}

function Row({ row, selected }: { readonly row: ChatRow; readonly selected: boolean }) {
  const chip = row.sourceState === 'removed' ? REMOVED_CHIP : row.sourceState === 'repointed' ? REPOINTED_CHIP : undefined;
  const second = row.turns === 0 ? CHAT_LIST_COPY.noQuestions : (row.lastQuestion ?? '');
  return (
    <li>
      <Link className={selected ? 'chat-list-row chat-list-row-selected' : 'chat-list-row'} to={`${ASSISTANT_PATH}/${encodeURIComponent(row.investigationId)}`} aria-current={selected ? 'true' : undefined}>
        <span className="chat-list-row-title">
          <span className="chat-list-row-name">{row.title}</span>
          {chip === undefined ? null : <span className="chat-list-chip">{chip}</span>}
        </span>
        <span className="chat-list-row-question">{second}</span>
      </Link>
    </li>
  );
}

/** The column of the chats of the person on the Assistant page: New chat, the search, the chats by the date of their last question, and the footnote. */
export function ChatListColumn({ onNewChat, newChatRef, now = () => new Date() }: ChatListColumnProps) {
  const state = useClientState();
  const session = useAssistantSession();
  const shownId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const settled = useStoreSelector(session.store, (held) => held.turns.filter((turn) => turn.outcome.kind !== 'pending').length);
  const epoch = useStoreSelector(session.store, (held) => held.epoch);
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const body = useRef<HTMLDivElement | null>(null);
  const { state: chats, reload, loadMore } = useChatList(query, `${settled}:${epoch}`);

  useEffect(() => {
    const trimmed = text.trim();
    const next = [...trimmed].length >= MIN_SEARCH_CHARACTERS ? trimmed : undefined;
    if (next === query) return;
    const timer = window.setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, query]);

  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    const shown = (): void => {
      // a window that is shown is made visible and focused together: one read serves both
      const now = Date.now();
      if (document.visibilityState === 'hidden' || now - last < SHOWN_COALESCE_MS) return;
      last = now;
      reload();
    };
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('focus', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('focus', shown);
    };
  }, [reload]);

  const groups = groupChats(chats.rows, now());
  const arrows = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(body.current?.querySelectorAll<HTMLAnchorElement>('.chat-list-row') ?? [])];
    const at = links.findIndex((link) => link === document.activeElement);
    if (at < 0) return;
    const next = links[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };
  const searching = query !== undefined;
  const empty = chats.first === 'ready' && chats.rows.length === 0;

  return (
    <aside className="chat-list" aria-label={CHAT_LIST_COPY.label}>
      <button ref={newChatRef} type="button" className="assistant-page-button chat-list-new" disabled={onNewChat === undefined} onClick={onNewChat}>
        <span className="icon icon-plus" aria-hidden="true" />
        {CHAT_LIST_COPY.newChat}
      </button>
      <label className="chat-list-search">
        <span className="icon icon-find" aria-hidden="true" />
        <input
          type="search"
          value={text}
          placeholder={CHAT_LIST_COPY.searchPlaceholder}
          aria-label={CHAT_LIST_COPY.searchLabel}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && text !== '') {
              event.preventDefault();
              setText('');
            }
          }}
        />
      </label>
      <div ref={body} className="chat-list-body" onKeyDown={arrows}>
        {chats.first === 'loading' && chats.rows.length === 0 ? (
          <p role="status" className="chat-list-note">
            {CHAT_LIST_COPY.loading}
          </p>
        ) : null}
        {chats.first === 'failed' ? (
          <div role="group" className="chat-list-failure">
            <FailureNotice failure={chats.firstFailure ?? { code: 'UNEXPECTED_FAILURE' }} />
            {chats.firstFailure === undefined || canRetry(chats.firstFailure) ? (
              <button type="button" className="chat-list-link" aria-label={CHAT_LIST_COPY.retryLabel} onClick={reload}>
                {CHAT_LIST_COPY.retry}
              </button>
            ) : null}
          </div>
        ) : null}
        {groups.map((grouped) => (
          <section key={grouped.group} className="chat-list-group" aria-label={CHAT_LIST_COPY.groups[grouped.group]}>
            <h2>{CHAT_LIST_COPY.groups[grouped.group]}</h2>
            <ul>
              {grouped.rows.map((row) => (
                <Row key={row.investigationId} row={row} selected={row.investigationId === shownId} />
              ))}
            </ul>
          </section>
        ))}
        {empty && chats.nextCursor === null ? (
          <p className="chat-list-note">{searching ? CHAT_LIST_COPY.noMatch : CHAT_LIST_COPY.empty}</p>
        ) : null}
        {chats.nextCursor !== null && chats.first !== 'loading' ? (
          <div className="chat-list-more">
            {chats.rows.length === 0 ? <p className="chat-list-note">{CHAT_LIST_COPY.moreMayExist}</p> : null}
            {chats.more === 'failed' && chats.moreFailure !== undefined ? <FailureNotice failure={chats.moreFailure} /> : null}
            <button type="button" className="chat-list-link" disabled={chats.more === 'loading'} onClick={loadMore}>
              {chats.more === 'loading' ? CHAT_LIST_COPY.loadingMore : CHAT_LIST_COPY.showMore}
            </button>
          </div>
        ) : null}
      </div>
      <p className="chat-list-note chat-list-foot">{CHAT_LIST_COPY.note}</p>
    </aside>
  );
}
