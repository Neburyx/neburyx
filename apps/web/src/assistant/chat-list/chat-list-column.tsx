import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { REMOVED_CHIP, REPOINTED_CHIP } from '../../lifecycle/copy.js';
import { SEARCH_DEBOUNCE_MS } from '../../patterns/start-entity.js';
import { ASSISTANT_PATH } from '../../shell/navigation.js';
import { useClientState } from '../../state/context.js';
import { useStoreSelector } from '../../state/store.js';
import { cuts } from '../cut-text.js';
import { ListFailure } from '../list-failure.js';
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

/** The full title and question of a row whose text is cut, drawn under it while the pointer is on it or it has the keyboard focus. */
interface RowTip {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly above: boolean;
  readonly byFocus: boolean;
  /** The address of the row it belongs to: the tip goes when that row does. */
  readonly href: string | null;
}

/** The room a tip needs under a row, in pixels, before it is drawn above the row. */
const TIP_ROOM = 120;
/** The gap between a row and its tip, in pixels. */
const TIP_GAP = 4;

/** The tip of a row, if its title or its question is cut: both texts in full. */
function tipOf(link: HTMLElement, byFocus: boolean): RowTip | undefined {
  const name = link.querySelector('.chat-list-row-name');
  const question = link.querySelector('.chat-list-row-question');
  const cut = [name, question].some((clip) => clip !== null && cuts(clip));
  if (!cut) return undefined;
  const box = link.getBoundingClientRect();
  const above = box.bottom + TIP_ROOM > window.innerHeight;
  const text = [name?.textContent ?? '', question?.textContent ?? ''].filter((part) => part !== '').join('\n');
  return { text, left: box.left, top: above ? box.top - TIP_GAP : box.bottom + TIP_GAP, above, byFocus, href: link.getAttribute('href') };
}

function Row({ row, selected, onTip }: { readonly row: ChatRow; readonly selected: boolean; readonly onTip: (tip: RowTip | undefined) => void }) {
  const chip = row.sourceState === 'removed' ? REMOVED_CHIP : row.sourceState === 'repointed' ? REPOINTED_CHIP : undefined;
  const second = row.turns === 0 ? CHAT_LIST_COPY.noQuestions : `${row.lastQuestion ?? ''}${row.lastQuestion !== null && row.lastQuestionCut ? '…' : ''}`;
  return (
    <li>
      <Link
        className={selected ? 'chat-list-row chat-list-row-selected' : 'chat-list-row'}
        to={`${ASSISTANT_PATH}/${encodeURIComponent(row.investigationId)}`}
        aria-current={selected ? 'true' : undefined}
        onMouseEnter={(event) => onTip(tipOf(event.currentTarget, false))}
        onMouseLeave={() => onTip(undefined)}
        onFocus={(event) => onTip(tipOf(event.currentTarget, true))}
        onBlur={() => onTip(undefined)}
      >
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
  const epoch = useStoreSelector(session.store, (held) => held.epoch);
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const body = useRef<HTMLDivElement | null>(null);
  const { state: chats, reload, turnAnswered, refreshIfOld, loadMore } = useChatList(query, epoch);
  const [tip, setTip] = useState<RowTip | undefined>(undefined);
  const added = useRef<{ readonly before: ReadonlySet<string>; readonly byKeyboard: boolean } | undefined>(undefined);
  // a turn this page sent that goes from pending to settled: the chat has a new question the list must show (a thread that is opened or loaded settles no turn of its own)
  const progress = useStoreSelector(session.store, (held) => held.turns.map((turn) => `${turn.id}:${turn.outcome.kind === 'pending' ? 'p' : 's'}`).join(','));
  const pendingBefore = useRef<{ readonly shown: string | null; readonly pending: ReadonlySet<string> }>({ shown: shownId, pending: new Set() });
  useEffect(() => {
    const entries = progress === '' ? [] : progress.split(',');
    const pending = new Set(entries.filter((entry) => entry.endsWith(':p')).map((entry) => entry.slice(0, -2)));
    const before = pendingBefore.current;
    const answered = before.shown === shownId && entries.some((entry) => entry.endsWith(':s') && before.pending.has(entry.slice(0, -2)));
    pendingBefore.current = { shown: shownId, pending };
    if (answered) turnAnswered(shownId);
  }, [progress, shownId, turnAnswered]);

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

  // a tip of a row that is no longer in the list (a search narrowed it, a read dropped the chat) goes with it, in the same commit that took the row away: no frame draws a tip with no row
  useLayoutEffect(() => {
    if (tip === undefined) return;
    const links = [...(body.current?.querySelectorAll<HTMLAnchorElement>('.chat-list-row') ?? [])];
    if (!links.some((link) => link.getAttribute('href') === tip.href)) setTip(undefined);
  }, [tip, chats.rows, query]);

  useEffect(() => {
    if (tip === undefined) return undefined;
    const hide = (): void => setTip(undefined);
    // Esc takes the tip away and goes no further when the keyboard opened it
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (tip.byFocus) event.stopPropagation();
      hide();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, [tip]);

  // after Show more the button is gone: focus goes to the first row that was not there before (the page stays where it is for a pointer)
  useLayoutEffect(() => {
    const wait = added.current;
    if (chats.more === 'failed' || chats.first === 'loading') added.current = undefined;
    if (wait === undefined || chats.more !== 'idle' || chats.first === 'loading') return;
    added.current = undefined;
    const fresh = chats.rows.find((row) => !wait.before.has(row.investigationId));
    if (fresh === undefined) return;
    const link = [...(body.current?.querySelectorAll<HTMLAnchorElement>('.chat-list-row') ?? [])].find((candidate) => candidate.getAttribute('href') === `${ASSISTANT_PATH}/${encodeURIComponent(fresh.investigationId)}`);
    link?.focus({ preventScroll: !wait.byKeyboard });
  }, [chats.rows, chats.more, chats.first]);
  const showMore = (event: MouseEvent<HTMLButtonElement>): void => {
    added.current = { before: new Set(chats.rows.map((row) => row.investigationId)), byKeyboard: event.detail === 0 };
    loadMore();
  };

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
    <aside className="chat-list" aria-label={CHAT_LIST_COPY.label} onPointerEnter={refreshIfOld} onFocusCapture={(event) => (event.currentTarget.contains(event.relatedTarget as Node | null) ? undefined : refreshIfOld())}>
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
        {chats.first === 'failed' ? <ListFailure failure={chats.firstFailure ?? { code: 'UNEXPECTED_FAILURE' }} onRetry={reload} /> : null}
        {groups.map((grouped) => (
          <div key={grouped.group} className="chat-list-group">
            <h2>{CHAT_LIST_COPY.groups[grouped.group]}</h2>
            <ul role="list" aria-label={CHAT_LIST_COPY.groups[grouped.group]}>
              {grouped.rows.map((row) => (
                <Row key={row.investigationId} row={row} selected={row.investigationId === shownId} onTip={setTip} />
              ))}
            </ul>
          </div>
        ))}
        {empty && chats.nextCursor === null ? (
          <p className="chat-list-note">{searching ? CHAT_LIST_COPY.noMatch : CHAT_LIST_COPY.empty}</p>
        ) : null}
        {chats.nextCursor !== null && chats.first !== 'loading' ? (
          <div className="chat-list-more">
            {chats.rows.length === 0 ? <p className="chat-list-note">{CHAT_LIST_COPY.moreMayExist}</p> : null}
            {chats.more === 'failed' && chats.moreFailure !== undefined ? <ListFailure failure={chats.moreFailure} /> : null}
            <button type="button" className="chat-list-link" disabled={chats.more === 'loading'} onClick={showMore}>
              {chats.more === 'loading' ? CHAT_LIST_COPY.loadingMore : CHAT_LIST_COPY.showMore}
            </button>
          </div>
        ) : null}
      </div>
      <p className="chat-list-note chat-list-foot">{CHAT_LIST_COPY.note}</p>
      {tip === undefined
        ? null
        : createPortal(
            <div className={`assistant-table-tip${tip.above ? ' assistant-table-tip-above' : ''}`} style={{ left: tip.left, top: tip.top }} aria-hidden="true">
              {tip.text}
            </div>,
            document.body,
          )}
    </aside>
  );
}
